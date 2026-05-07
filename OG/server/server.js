// Ember Crown — local middleman server (rev-2 / objective-engine).
// Bridges browser <-> Claude Agent SDK using the orchestrator from
// lib/objective-orchestrator.mjs. See OBJECTIVE_REFACTOR_PLAN.md §3.2/§3.3.
//
// Routes:
//   GET  /health                liveness check
//   POST /turn                  { gameId, choice? }   choice optional on turn 1
//   POST /investigate           { gameId, beatNumber, linkId }
//   GET  /state?gameId=         filtered public state
//   POST /reset                 { gameId }            wipes state + log

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';

import {
  PORT, STATE_DIR, LOGS_DIR, DEFAULT_WORLD
} from './lib/config.mjs';
import { loadWorldBundle, getCachedBundle } from './lib/world-bundle.mjs';
import { readState, writeState, deleteState } from './lib/state-store.mjs';
import {
  appendTurnEntry, appendAppliedMarker, tailTurnEntries, deleteLog
} from './lib/beat-log.mjs';
import { acquire } from './lib/lock.mjs';

import { initGame, submitChoice, openLink } from './lib/objective-orchestrator.mjs';
import { defaultModelClient } from './lib/model-client.mjs';
import { buildKnowledgeView } from './lib/knowledge-layer.mjs';

// ---------- boot ----------

function ensureDirs() {
  for (const d of [STATE_DIR, LOGS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function bootstrap() {
  ensureDirs();
  loadWorldBundle(DEFAULT_WORLD);
  console.log(`[boot] world bundle loaded: ${DEFAULT_WORLD}`);
}

bootstrap();

// ---------- express setup ----------

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ---------- helpers ----------

/** Returns the most-recent presented beat from the log (for choice lookup). */
function lastPresentedBeat(gameId) {
  const turns = tailTurnEntries(gameId, 1);
  if (turns.length === 0) return null;
  // We stash the presented beat under modelOutput.presentedBeat
  return turns[0].modelOutput?.presentedBeat ?? null;
}

/** Build the slice of state the browser is allowed to see. */
function publicState(state, bundle) {
  const view = buildKnowledgeView(state, bundle);
  return {
    gameId:           state.gameId,
    turnNumber:       state.turnNumber,
    clockHours:       view.leanState.clockHours,
    condition:        view.leanState.condition,
    location:         view.leanState.location,
    assets:           view.leanState.assets,
    worldState:       view.worldState,        // includes timeOfDay, cometStage, kingStatus, etc.
    knownThreats:     view.knownThreats,
    investigatedFacts:view.investigatedFacts,
    rumors:           view.rumors,
    terminalState:    state.terminalState
  };
}

function logTurn(gameId, beatNumber, payload) {
  const entry = appendTurnEntry(gameId, {
    beatNumber,
    playerChoice:       payload.playerChoice ?? null,
    modelInput:         payload.modelInput ?? null,
    modelOutput:        payload.modelOutput ?? null,
    intendedStateAfter: payload.intendedStateAfter ?? null,
    notes:              payload.notes ?? null
  });
  appendAppliedMarker(gameId, beatNumber);
  return entry;
}

function persist(gameId, state) {
  state.lastAppliedLogTurn = state.turnNumber;
  writeState(gameId, state);
}

// ---------- routes ----------

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/turn', async (req, res) => {
  const { gameId, choice = null } = req.body || {};
  if (!gameId || typeof gameId !== 'string') {
    return res.status(400).json({ error: 'missing_or_invalid_gameId' });
  }

  const release = await acquire(gameId);
  try {
    const bundle = getCachedBundle(DEFAULT_WORLD);
    let state = readState(gameId);

    // ----- Turn 1: opening scene, no model call -----
    if (!state) {
      const { state: seeded, response } = initGame({ gameId, bundle });
      state = seeded;
      persist(gameId, state);
      logTurn(gameId, 1, {
        playerChoice: null,
        modelOutput: { presentedBeat: response }
      });
      return res.json({
        ok: true,
        beatNumber: response.beatNumber,
        isOpening: true,
        isEnding: false,
        prose: response.prose,
        linkContents: response.linkContents,
        choices: response.choices,
        publicState: publicState(state, bundle)
      });
    }

    // ----- Turn 2+: requires a choice -----
    if (!choice || typeof choice !== 'string') {
      return res.status(400).json({ error: 'missing_choice_label' });
    }

    const lastBeat = lastPresentedBeat(gameId);
    const choicesPresented = lastBeat?.choices ?? lastBeat?.nextBeat?.choices ?? [];

    const result = await submitChoice(state, bundle, {
      choiceLabel: choice,
      choicesPresented,
      modelClient: defaultModelClient
    });

    if (!result.response) {
      return res.status(422).json({
        error: 'turn_failed',
        log: result.log
      });
    }

    persist(gameId, state);
    logTurn(gameId, state.turnNumber, {
      playerChoice: choice,
      modelOutput: { presentedBeat: result.response.nextBeat ?? result.response, raw: result.log?.output ?? null },
      intendedStateAfter: state,
      notes: result.retried ? 'retried-once' : null
    });

    return res.json({
      ok: true,
      beatNumber:             result.response.beatNumber,
      isOpening:              false,
      isEnding:               result.response.isEnding,
      terminalState:          result.response.terminalState,
      forced:                 result.response.forced ?? false,
      resolutionProse:        result.response.resolutionProse,
      resolutionLinkContents: result.response.resolutionLinkContents,
      nextBeat:               result.response.nextBeat,
      publicState:            publicState(state, bundle)
    });
  } catch (err) {
    console.error('[/turn] error:', err);
    return res.status(500).json({ error: 'turn_handler_error', detail: String(err.message || err) });
  } finally {
    release();
  }
});

app.post('/investigate', async (req, res) => {
  const { gameId, beatNumber, linkId } = req.body || {};
  if (!gameId || typeof gameId !== 'string') return res.status(400).json({ error: 'missing_or_invalid_gameId' });
  if (typeof beatNumber !== 'number')        return res.status(400).json({ error: 'missing_or_invalid_beatNumber' });
  if (!linkId || typeof linkId !== 'string') return res.status(400).json({ error: 'missing_or_invalid_linkId' });

  const release = await acquire(gameId);
  try {
    const bundle = getCachedBundle(DEFAULT_WORLD);
    const state = readState(gameId);
    if (!state) return res.status(404).json({ error: 'no_such_game' });

    // Find the right linkContents map: prefer the most recently presented beat.
    const lastBeat = lastPresentedBeat(gameId);
    const candidateMaps = [
      lastBeat?.linkContents,                 // opening
      lastBeat?.resolutionLinkContents,       // most recent resolution
      lastBeat?.nextBeat?.introLinkContents,  // intro of presented next-beat
      lastBeat?.introLinkContents             // shape variant
    ].filter(Boolean);
    const linkContents = candidateMaps.find(m => Object.prototype.hasOwnProperty.call(m, linkId));
    if (!linkContents) return res.status(404).json({ error: 'link_not_found_for_beat', linkId });

    const { result } = openLink(state, bundle, { beatNumber, linkId, linkContents });
    if (!result.ok) return res.status(400).json({ error: result.error });

    persist(gameId, state);
    return res.json({
      ok: true,
      content:          result.content,
      alreadyOpened:    result.alreadyOpened,
      costHoursApplied: result.costHoursApplied,
      unlocksFacts:     result.unlocksFacts,
      unlocksThreats:   result.unlocksThreats,
      publicState:      publicState(state, bundle)
    });
  } catch (err) {
    console.error('[/investigate] error:', err);
    return res.status(500).json({ error: 'investigate_handler_error', detail: String(err.message || err) });
  } finally {
    release();
  }
});

app.get('/state', (req, res) => {
  const gameId = String(req.query.gameId || '');
  if (!gameId) return res.status(400).json({ error: 'missing_gameId' });
  const bundle = getCachedBundle(DEFAULT_WORLD);
  const state = readState(gameId);
  if (!state) return res.status(404).json({ error: 'no_such_game' });
  return res.json({ ok: true, publicState: publicState(state, bundle) });
});

app.post('/reset', async (req, res) => {
  const { gameId } = req.body || {};
  if (!gameId || typeof gameId !== 'string') return res.status(400).json({ error: 'missing_or_invalid_gameId' });
  const release = await acquire(gameId);
  try {
    deleteState(gameId);
    deleteLog(gameId);
    return res.json({ ok: true });
  } finally {
    release();
  }
});

// ---------- listen ----------

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Ember Crown server listening on http://127.0.0.1:${PORT}`);
});
