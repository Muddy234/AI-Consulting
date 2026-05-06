// Ember Crown — local middleman server.
// Bridges browser <-> Claude Agent SDK using the staged-turn write-ahead flow
// described in IMPLEMENTATION_PLAN.md §5.

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  PORT,
  MODEL,
  STATE_DIR,
  LOGS_DIR,
  DEFAULT_WORLD,
  RECENT_HISTORY_BEATS
} from './lib/config.mjs';
import { convertXlsxToBundle } from './tools/xlsx-to-bundle.mjs';
import { loadWorldBundle, getCachedBundle, knownNpcIds } from './lib/world-bundle.mjs';
import { readState, writeState, deleteState } from './lib/state-store.mjs';
import {
  appendTurnEntry,
  appendAppliedMarker,
  tailTurnEntries,
  deleteLog
} from './lib/beat-log.mjs';
import { acquire } from './lib/lock.mjs';
import { recoverAllGames } from './lib/recovery.mjs';
import { composePrompt } from './lib/prompt-composer.mjs';
import { applyDeltas } from './lib/delta-applier.mjs';
import {
  validateModelOutput,
  formatErrors,
  firstError,
  RE_PROMPT_TEMPLATE
} from './lib/validator.mjs';
import { makeProseExtractor } from './lib/prose-extractor.mjs';

// ---------- boot ----------

function ensureDirs() {
  for (const d of [STATE_DIR, LOGS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function bootstrap() {
  ensureDirs();
  // Regenerate world bundle if xlsx is newer (mtime-aware, silent on no-op).
  try {
    convertXlsxToBundle({ silent: true });
  } catch (err) {
    console.error('[boot] xlsx converter failed:', err.message);
  }
  // Load + validate world bundle (throws on invalid).
  loadWorldBundle(DEFAULT_WORLD);

  // Recover any games whose state lags their log.
  const results = recoverAllGames();
  for (const r of results) {
    if (r.warning) console.warn(`[boot] recovery warning for ${r.gameId}: ${r.warning}`);
    if (!r.ok) console.error(`[boot] recovery error for ${r.gameId}: ${r.error}`);
    if (r.replayedBeats?.length) {
      console.log(`[boot] recovered ${r.gameId}: replayed beats ${r.replayedBeats.join(', ')}`);
    }
  }
}

bootstrap();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ ok: true, model: MODEL, world: DEFAULT_WORLD }));

// ---------- helpers ----------

/** Builds the initial state file from the world bundle's starting data. */
function buildInitialState(gameId, world) {
  const ts = new Date().toISOString();
  const npcStates = {};
  for (const c of world.characters || []) {
    npcStates[c.id] = {
      location: c.startingLocation || 'unknown',
      status: c.startingStatus || '',
      currentKnowledge: Array.isArray(c.startingKnowledge)
        ? c.startingKnowledge.map(k => ({ ...k, source: 'authored' }))
        : (c.knowledgeText ? [{ fact: c.knowledgeText, confidence: 'certain', source: 'authored' }] : [])
    };
  }
  return {
    gameId,
    worldName: world.worldName,
    createdAt: ts,
    lastTurnAt: ts,
    beatNumber: 1,
    lastAppliedLogBeat: 1,
    worldState: {
      worldDay: 1,
      cumulativeHoursElapsed: 0,
      timeOfDay: 'dawn',
      majorEvents: []
    },
    playerState: {
      location: world.playerStartingState?.location || '',
      condition: world.playerStartingState?.condition || 'well',
      inventory: world.playerStartingState?.inventory || [],
      privateKnowledge: world.playerStartingState?.knowledgeText
        ? [{ fact: world.playerStartingState.knowledgeText, confidence: 'certain', source: 'authored' }]
        : []
    },
    npcStates,
    plotTrajectory: {
      currentPath: null,
      lastDirectorReasoning: null
    },
    forwardProjection: null,
    lastIsEnding: false
  };
}

/** Pulls the JSON object out of model output text. Tolerates stray prose. */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  // Try a clean parse first.
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // Find the first '{' and the matching closing '}' by balance, respecting strings.
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Calls the Agent SDK and collects the result text + token usage. */
async function callModel({ prompt, systemPrompt, resume, onTextDelta = null }) {
  const options = {
    model: MODEL,
    maxTurns: 1,
    stderr: (line) => console.error('[claude-cli stderr]', line)
  };
  if (onTextDelta) options.includePartialMessages = true;
  if (resume) options.resume = resume;
  if (!resume && systemPrompt) options.systemPrompt = systemPrompt;

  let resultText = '';
  let sessionId = null;
  let usage = null;
  let isError = false;
  let errorDetail = null;

  for await (const msg of query({ prompt, options })) {
    if (msg.session_id) sessionId = msg.session_id;

    // Forward incremental text deltas from the raw Anthropic stream events.
    if (onTextDelta && msg.type === 'stream_event') {
      const evt = msg.event;
      if (evt && evt.type === 'content_block_delta'
          && evt.delta && evt.delta.type === 'text_delta'
          && typeof evt.delta.text === 'string') {
        try { onTextDelta(evt.delta.text); }
        catch (e) { console.error('[onTextDelta threw]', e); }
      }
    }

    if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        resultText = msg.result || '';
      } else {
        isError = true;
        errorDetail = { subtype: msg.subtype, errors: msg.errors };
      }
      if (msg.usage) usage = msg.usage;
    }
  }

  return { resultText, sessionId, usage, isError, errorDetail };
}

/** Returns { tokensIn, tokensOut } from an SDK usage object, defaulting to 0. */
function tokensFromUsage(usage) {
  if (!usage) return { tokensIn: 0, tokensOut: 0 };
  return {
    tokensIn: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) +
              (usage.cache_creation_input_tokens || 0),
    tokensOut: usage.output_tokens || 0
  };
}

/** Builds the dev-mode public-state block (deterministic bookkeeping only). */
function buildPublicState(state, world) {
  const charactersById = new Map((world?.characters || []).map(c => [c.id, c]));
  const npcs = Object.entries(state.npcStates || {}).map(([id, s]) => {
    const c = charactersById.get(id);
    return {
      id,
      name: c?.name || id,
      role: c?.role || '',
      location: s.location || '',
      status: s.status || ''
    };
  });
  return {
    worldDay: state.worldState?.worldDay ?? null,
    timeOfDay: state.worldState?.timeOfDay ?? null,
    cumulativeHoursElapsed: state.worldState?.cumulativeHoursElapsed ?? 0,
    majorEvents: Array.isArray(state.worldState?.majorEvents) ? state.worldState.majorEvents : [],
    player: {
      location: state.playerState?.location || '',
      condition: state.playerState?.condition || '',
      inventory: Array.isArray(state.playerState?.inventory) ? state.playerState.inventory : []
    },
    npcs
  };
}

/** Shape returned to the browser. */
function turnResponse(state, prose, choices, isEnding, world) {
  return {
    beatNumber: state.beatNumber,
    prose,
    choices,
    isEnding: !!isEnding,
    publicState: buildPublicState(state, world)
  };
}

// ---------- /turn ----------

app.post('/turn', async (req, res) => {
  const { gameId, choice = null } = req.body || {};
  if (!gameId || typeof gameId !== 'string') {
    return res.status(400).json({ error: 'missing_or_invalid_gameId' });
  }

  const release = await acquire(gameId);
  try {
    const world = getCachedBundle(DEFAULT_WORLD);
    let state = readState(gameId);

    // ----- Turn 1: opening beat, no model call -----
    if (!state) {
      state = buildInitialState(gameId, world);
      // Synthetic beat-1 log entry so recovery and history both work.
      appendTurnEntry(gameId, {
        beatNumber: 1,
        playerChoice: null,
        modelInput: null,
        modelOutput: world.openingBeat?.prose || '',
        stateBefore: null,
        intendedStateAfter: state,
        tokensIn: 0,
        tokensOut: 0,
        notes: 'opening beat (synthetic)'
      });
      writeState(gameId, state);
      appendAppliedMarker(gameId, 1);

      return res.json(turnResponse(
        state,
        world.openingBeat?.prose || '',
        world.openingBeat?.choices || [],
        false,
        world
      ));
    }

    // ----- Turn 2+: composed prompt + model call -----
    if (!choice || !['A', 'B', 'C'].includes(choice)) {
      return res.status(400).json({ error: 'invalid_choice', detail: 'choice must be "A", "B", or "C"' });
    }

    const recentTurnEntries = tailTurnEntries(gameId, RECENT_HISTORY_BEATS);

    // Resolve the choice menu the player just picked from, so the model can map
    // the letter back to the action. Beat 1's menu lives in the world bundle;
    // for later beats it lives in the prior beat's modelOutput.
    let priorChoices = null;
    if (state.beatNumber === 1) {
      priorChoices = world.openingBeat?.choices || null;
    } else {
      const latest = recentTurnEntries[recentTurnEntries.length - 1];
      priorChoices = latest?.modelOutput?.narrativeResponse?.nextBeat?.choices || null;
    }

    if (!state.plotTrajectory) state.plotTrajectory = {};

    const prompt = composePrompt({
      world,
      state,
      recentTurnEntries,
      playerChoice: choice,
      priorChoices,
      opts: { ending: state.lastIsEnding === true && state.beatNumber >= (world.pacingBudget?.climaxByBeat || 6) }
    });

    // First call.
    let modelCall = await callModel({
      prompt,
      systemPrompt: 'You are the narrative director for an adaptive prose game. Return ONLY a JSON object matching the schema in the prompt.',
      resume: null
    });
    if (modelCall.isError) {
      return res.status(500).json({ error: 'agent_error', detail: modelCall.errorDetail });
    }

    let parsed = extractJson(modelCall.resultText);
    let validation = parsed
      ? validateModelOutput(parsed, { knownNpcIds: knownNpcIds(world) })
      : { ok: false, errors: [{ path: 'output', message: 'response was not parseable JSON' }] };

    let tokensInTotal = tokensFromUsage(modelCall.usage).tokensIn;
    let tokensOutTotal = tokensFromUsage(modelCall.usage).tokensOut;

    // One-shot re-prompt on validation failure (resume same SDK session).
    if (!validation.ok) {
      const first = firstError(validation.errors);
      const retryPrompt = RE_PROMPT_TEMPLATE(first?.path || 'output', first?.message || 'invalid');
      const retry = await callModel({ prompt: retryPrompt, resume: modelCall.sessionId });
      if (retry.isError) {
        return res.status(500).json({ error: 'agent_error_on_retry', detail: retry.errorDetail });
      }
      const retryTok = tokensFromUsage(retry.usage);
      tokensInTotal += retryTok.tokensIn;
      tokensOutTotal += retryTok.tokensOut;

      parsed = extractJson(retry.resultText);
      validation = parsed
        ? validateModelOutput(parsed, { knownNpcIds: knownNpcIds(world) })
        : { ok: false, errors: [{ path: 'output', message: 'retry response was not parseable JSON' }] };
      if (!validation.ok) {
        return res.status(500).json({
          error: 'schema_validation_failed_after_retry',
          detail: formatErrors(validation.errors)
        });
      }
    }

    const validated = validation.value;

    // ----- write-ahead: log first, mutate state second -----
    const nextBeatNumber = state.beatNumber + 1;
    const ts = new Date().toISOString();
    const { state: nextState, warnings } = applyDeltas(state, validated, { beatNumber: nextBeatNumber, ts });
    for (const w of warnings) console.warn(`[turn ${gameId} beat ${nextBeatNumber}]`, w);

    appendTurnEntry(gameId, {
      beatNumber: nextBeatNumber,
      playerChoice: choice,
      modelInput: prompt,
      modelOutput: validated,
      stateBefore: state,
      intendedStateAfter: nextState,
      tokensIn: tokensInTotal,
      tokensOut: tokensOutTotal
    });
    writeState(gameId, nextState);
    appendAppliedMarker(gameId, nextBeatNumber);

    const proseOut = [
      validated.narrativeResponse?.resolutionProse,
      validated.narrativeResponse?.nextBeat?.intro
    ].filter(Boolean).join('\n\n');

    return res.json(turnResponse(
      nextState,
      proseOut,
      validated.narrativeResponse?.nextBeat?.choices || [],
      validated.narrativeResponse?.isEnding,
      world
    ));
  } catch (err) {
    console.error('[turn] handler threw:', err);
    return res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
  } finally {
    release();
  }
});

// ---------- /turn/stream (SSE) ----------

function sseSetup(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.post('/turn/stream', async (req, res) => {
  const { gameId, choice = null } = req.body || {};
  if (!gameId || typeof gameId !== 'string') {
    return res.status(400).json({ error: 'missing_or_invalid_gameId' });
  }

  sseSetup(res);
  let released = false;
  const release = await acquire(gameId);
  const safeRelease = () => { if (!released) { released = true; release(); } };
  req.on('close', safeRelease);

  try {
    const world = getCachedBundle(DEFAULT_WORLD);
    let state = readState(gameId);

    // ----- Turn 1: opening beat, no model call -----
    if (!state) {
      state = buildInitialState(gameId, world);
      const openingProse = world.openingBeat?.prose || '';
      appendTurnEntry(gameId, {
        beatNumber: 1,
        playerChoice: null,
        modelInput: null,
        modelOutput: openingProse,
        stateBefore: null,
        intendedStateAfter: state,
        tokensIn: 0,
        tokensOut: 0,
        notes: 'opening beat (synthetic)'
      });
      writeState(gameId, state);
      appendAppliedMarker(gameId, 1);

      // Stream opening prose char-by-char-ish for UX consistency, then final.
      sseSend(res, 'prose', { text: openingProse });
      sseSend(res, 'final', turnResponse(
        state, openingProse, world.openingBeat?.choices || [], false, world
      ));
      res.end();
      return;
    }

    // ----- Turn 2+: composed prompt + streaming model call -----
    if (!choice || !['A', 'B', 'C'].includes(choice)) {
      sseSend(res, 'error', { error: 'invalid_choice', detail: 'choice must be "A", "B", or "C"' });
      res.end();
      return;
    }

    const recentTurnEntries = tailTurnEntries(gameId, RECENT_HISTORY_BEATS);

    let priorChoices = null;
    if (state.beatNumber === 1) {
      priorChoices = world.openingBeat?.choices || null;
    } else {
      const latest = recentTurnEntries[recentTurnEntries.length - 1];
      priorChoices = latest?.modelOutput?.narrativeResponse?.nextBeat?.choices || null;
    }

    if (!state.plotTrajectory) state.plotTrajectory = {};

    const prompt = composePrompt({
      world,
      state,
      recentTurnEntries,
      playerChoice: choice,
      priorChoices,
      opts: { ending: state.lastIsEnding === true && state.beatNumber >= (world.pacingBudget?.climaxByBeat || 6) }
    });

    // Build a prose extractor that pipes deltas into SSE.
    const makeStreamingExtractor = () => makeProseExtractor((text) => {
      sseSend(res, 'prose', { text });
    });
    let extractor = makeStreamingExtractor();

    // First call.
    let modelCall = await callModel({
      prompt,
      systemPrompt: 'You are the narrative director for an adaptive prose game. Return ONLY a JSON object matching the schema in the prompt.',
      resume: null,
      onTextDelta: (t) => extractor.push(t)
    });
    if (modelCall.isError) {
      sseSend(res, 'error', { error: 'agent_error', detail: modelCall.errorDetail });
      res.end();
      return;
    }

    let parsed = extractJson(modelCall.resultText);
    let validation = parsed
      ? validateModelOutput(parsed, { knownNpcIds: knownNpcIds(world) })
      : { ok: false, errors: [{ path: 'output', message: 'response was not parseable JSON' }] };

    let tokensInTotal = tokensFromUsage(modelCall.usage).tokensIn;
    let tokensOutTotal = tokensFromUsage(modelCall.usage).tokensOut;

    if (!validation.ok) {
      // Whatever prose we streamed is now stale. Tell the browser to reset.
      sseSend(res, 'prose-reset', {});
      extractor = makeStreamingExtractor();

      const first = firstError(validation.errors);
      const retryPrompt = RE_PROMPT_TEMPLATE(first?.path || 'output', first?.message || 'invalid');
      const retry = await callModel({
        prompt: retryPrompt,
        resume: modelCall.sessionId,
        onTextDelta: (t) => extractor.push(t)
      });
      if (retry.isError) {
        sseSend(res, 'error', { error: 'agent_error_on_retry', detail: retry.errorDetail });
        res.end();
        return;
      }
      const retryTok = tokensFromUsage(retry.usage);
      tokensInTotal += retryTok.tokensIn;
      tokensOutTotal += retryTok.tokensOut;

      parsed = extractJson(retry.resultText);
      validation = parsed
        ? validateModelOutput(parsed, { knownNpcIds: knownNpcIds(world) })
        : { ok: false, errors: [{ path: 'output', message: 'retry response was not parseable JSON' }] };
      if (!validation.ok) {
        sseSend(res, 'error', {
          error: 'schema_validation_failed_after_retry',
          detail: formatErrors(validation.errors)
        });
        res.end();
        return;
      }
    }

    const validated = validation.value;

    const nextBeatNumber = state.beatNumber + 1;
    const ts = new Date().toISOString();
    const { state: nextState, warnings } = applyDeltas(state, validated, { beatNumber: nextBeatNumber, ts });
    for (const w of warnings) console.warn(`[turn ${gameId} beat ${nextBeatNumber}]`, w);

    appendTurnEntry(gameId, {
      beatNumber: nextBeatNumber,
      playerChoice: choice,
      modelInput: prompt,
      modelOutput: validated,
      stateBefore: state,
      intendedStateAfter: nextState,
      tokensIn: tokensInTotal,
      tokensOut: tokensOutTotal
    });
    writeState(gameId, nextState);
    appendAppliedMarker(gameId, nextBeatNumber);

    const proseOut = [
      validated.narrativeResponse?.resolutionProse,
      validated.narrativeResponse?.nextBeat?.intro
    ].filter(Boolean).join('\n\n');

    sseSend(res, 'final', turnResponse(
      nextState,
      proseOut,
      validated.narrativeResponse?.nextBeat?.choices || [],
      validated.narrativeResponse?.isEnding,
      world
    ));
    res.end();
  } catch (err) {
    console.error('[turn/stream] handler threw:', err);
    try { sseSend(res, 'error', { error: 'server_error', detail: String(err.message || err) }); } catch {}
    try { res.end(); } catch {}
  } finally {
    safeRelease();
  }
});

// ---------- /reset ----------

app.post('/reset', (req, res) => {
  const { gameId } = req.body || {};
  if (!gameId || typeof gameId !== 'string') {
    return res.status(400).json({ error: 'missing_or_invalid_gameId' });
  }
  deleteState(gameId);
  deleteLog(gameId);
  res.json({ ok: true });
});

// ---------- listen ----------

app.listen(PORT, () => {
  console.log(`Ember Crown server listening on http://localhost:${PORT}`);
  console.log(`Endpoints: POST /turn  POST /turn/stream  POST /reset  GET /health`);
  console.log(`World: ${DEFAULT_WORLD}  Model: ${MODEL}`);
});
