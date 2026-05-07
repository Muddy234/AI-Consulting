// Per-turn orchestrator (Phase I). Wires together everything from
// Phase D-H into the staged-turn flow described in OBJECTIVE_REFACTOR_PLAN
// §3.2. The HTTP layer (server.js) is a thin shell over these functions.
//
// Public surface:
//   initGame({ gameId, bundle })
//     -> { state, response }
//          response is the opening scene rendered as a turn-1 reply
//
//   submitChoice(state, bundle, {
//     choiceLabel,
//     choicesPresented,    // array shown to player on previous beat
//     recentHistory,       // [{ title, prose }] for prompt context
//     modelClient          // { call({ system, user }) -> Promise<output> }
//   })
//     -> { state, response, log, validationStripped, retried }
//
//   openLink(state, bundle, {
//     beatNumber, linkId, linkContents
//   })
//     -> { state, result }   (result is applyInvestigation's return)
//
// The orchestrator never imports express; HTTP / SSE / persistence is the
// caller's job. This keeps the per-turn flow unit-testable with a mock
// model client.

import { tickThreats, applyOnComplete } from './threat-engine.mjs';
import { tickScheduledEvents, addModelScheduledEvent } from './scheduled-events-engine.mjs';
import { applyInvestigation } from './investigation.mjs';
import { composePrompt } from './objective-prompt-composer.mjs';
import {
  validateModelOutput,
  RE_PROMPT_TEMPLATE,
  firstError,
  formatErrors
} from './objective-validator.mjs';
import { seedNewGame } from './state-seeder.mjs';

// ----- init -----

/**
 * Build a fresh game and produce the opening response. No model call.
 * Returns { state, response }.
 */
export function initGame({ gameId, bundle }) {
  const state = seedNewGame({ gameId, bundle });
  const opening = bundle.openingScene || null;

  const response = {
    beatNumber: 1,
    isOpening: true,
    isEnding: false,
    terminalState: null,
    location: opening?.location ?? null,
    prose: opening?.prose ?? { segments: [] },
    linkContents: opening?.linkContents ?? {},
    choices: opening?.choices ?? []
  };

  return { state, response };
}

// ----- per-turn -----

export async function submitChoice(state, bundle, {
  choiceLabel,
  choicesPresented = [],
  recentHistory = [],
  modelClient,
  reprompts = 1   // one retry on schema fail per §3.2 step 6
} = {}) {
  if (!modelClient || typeof modelClient.call !== 'function') {
    throw new Error('submitChoice requires a modelClient with .call({ system, user })');
  }

  // 1. Resolve the chosen option from what the player saw last turn.
  const chosen = choicesPresented.find(c => c?.label === choiceLabel);
  if (!chosen) {
    return _failResponse(state, `unknown choice label '${choiceLabel}'`);
  }

  // 2. Pre-turn forced-terminal check (state.clockHours could already be 0
  // from the previous turn's deltas, or a forced-end threat could have
  // completed silently last tick).
  const forced = forcedTerminalCheck(state, bundle);
  if (forced) {
    state.terminalState = forced;
    finalizeRunHistory(state);
    return {
      state,
      response: {
        beatNumber: state.turnNumber,
        isOpening: false,
        isEnding: true,
        terminalState: forced,
        prose: { segments: [{ type: 'text', content: forced.summary }] },
        linkContents: {},
        choices: [],
        forced: true
      },
      log: { kind: 'forced-terminal', terminalKind: forced.kind },
      validationStripped: [],
      retried: false
    };
  }

  // 3. Stamp the chosen risk into state for the lethality gate.
  state.lastChoiceRisk = chosen.risk ?? null;

  // 4. Build the lastChoice block for the prompt.
  const lastChoice = {
    label: chosen.label,
    text:  chosen.text,
    risk:  chosen.risk,
    otherChoices: choicesPresented
      .filter(c => c.label !== chosen.label)
      .map(c => ({ label: c.label, text: c.text, risk: c.risk }))
  };

  // 5. Compose prompt.
  const { system, user } = composePrompt(state, bundle, {
    recentHistory,
    lastChoice,
    hudChanges: [],
    sinceHour: 0
  });

  // 6. Call the model, with one retry on validation failure.
  let output;
  let validation;
  let retried = false;

  output = await modelClient.call({ system, user });
  validation = validateModelOutput(output, { state, bundle });

  if (!validation.ok && reprompts > 0) {
    retried = true;
    const e = firstError(validation.errors) ?? { path: '<unknown>', message: 'invalid output' };
    const repromptUser = `${user}\n\n${RE_PROMPT_TEMPLATE(e.path, e.message)}`;
    output = await modelClient.call({ system, user: repromptUser });
    validation = validateModelOutput(output, { state, bundle });
  }

  if (!validation.ok) {
    return {
      state,
      response: null,
      log: {
        kind: 'validation-failed',
        errors: validation.errors,
        formatted: formatErrors(validation.errors)
      },
      validationStripped: validation.stripped ?? [],
      retried
    };
  }

  // 7. Apply deltas from the validated model output.
  applyModelDeltas(state, output);
  state.turnNumber += 1;

  // 8. World tick (threats + scheduled events) using the delta as elapsed time.
  const clockHoursDelta = output?.worldImpacts?.stateChanges?.clockHoursDelta ?? 0;
  const threatSlowdowns = output?.worldImpacts?.threatSlowdowns ?? [];
  const currentHour = ((bundle?.startingClocks?.clockHours ?? 96) - state.clockHours);

  const threatTick = tickThreats(state, bundle, {
    clockHoursDelta,
    threatSlowdowns,
    currentHour
  });
  for (const completion of threatTick.completions) {
    applyOnComplete(state, completion.onComplete);
  }

  const eventTick = tickScheduledEvents(state, bundle, { currentHour });

  // 9. Process model-authored adds.
  for (const ev of (output?.worldImpacts?.scheduledEventsToAdd ?? [])) {
    try { addModelScheduledEvent(state, ev); }
    catch (err) { /* validator already prevented collisions; defensive */ }
  }
  for (const t of (output?.worldImpacts?.macroThreatsToAdd ?? [])) {
    if (!state.threats[t.id]) {
      state.threats[t.id] = {
        progress: 0,
        currentPhase: t.phases?.[0]?.label ?? null,
        slowedBy: 0,
        knownToPlayer: false,
        revealedAtHour: null,
        completed: false,
        completedAt: null,
        authorSource: 'model'
      };
      // NOTE: model-authored threat definitions (duration / phases /
      // onComplete) are not yet stored in state and so do not tick. See
      // Phase D commit message for the deferred fix.
    }
  }

  // 10. Update runHistory from the tick results.
  updateRunHistoryFromTick(state, threatTick, eventTick);

  // 11. Terminal predicates from model output.
  const modelTerminal = output?.narrativeResponse?.terminalState ?? null;
  const isEnding = Boolean(output?.narrativeResponse?.isEnding) || Boolean(modelTerminal);
  if (modelTerminal) {
    state.terminalState = modelTerminal;
    finalizeRunHistory(state);
  } else {
    // Engine-side override: if deltas just pushed clockHours <= 0 and the
    // model didn't declare an ending, the next turn will force time-up.
    // We don't override the current model output (that would replace the
    // resolution prose the player needs to see), but the next submitChoice
    // pre-turn check will catch it.
  }

  // 12. Build the browser-facing response.
  const nb = output?.narrativeResponse?.nextBeat ?? null;
  const response = {
    beatNumber: state.turnNumber,
    isOpening: false,
    isEnding,
    terminalState: modelTerminal,
    resolutionProse:        output?.narrativeResponse?.resolutionProse        ?? { segments: [] },
    resolutionLinkContents: output?.narrativeResponse?.resolutionLinkContents ?? {},
    nextBeat: nb,
    threatTick,
    eventTick,
    forwardProjection: output?.forwardProjection ?? null
  };

  return {
    state,
    response,
    log: {
      kind: 'turn-complete',
      output,
      threatTick,
      eventTick,
      stripped: validation.stripped
    },
    validationStripped: validation.stripped ?? [],
    retried
  };
}

// ----- investigate -----

/**
 * Wraps applyInvestigation. The orchestrator owns runHistory updates
 * because applyInvestigation is engine-pure.
 */
export function openLink(state, bundle, { beatNumber, linkId, linkContents } = {}) {
  const before = (bundle?.startingClocks?.clockHours ?? 96) - state.clockHours;
  const result = applyInvestigation(state, bundle, {
    beatNumber, linkId, linkContents, currentHour: before
  });
  if (result.ok && !result.alreadyOpened && result.tickResults) {
    updateRunHistoryFromTick(state, result.tickResults.threatTick, result.tickResults.eventTick);
  }
  return { state, result };
}

// ============================================================
// internals
// ============================================================

function applyModelDeltas(state, output) {
  const sc = output?.worldImpacts?.stateChanges ?? {};

  // clockHours decrements (cost in hours), clamped at 0
  const before = state.clockHours;
  state.clockHours = Math.max(0, before - (sc.clockHoursDelta ?? 0));

  // distanceToKing increments (negative = closer), clamped 0..100
  const dd = sc.distanceDelta ?? 0;
  state.distanceToKing = Math.max(0, Math.min(100, state.distanceToKing + dd));

  if (sc.conditionChange) state.condition = sc.conditionChange;

  if (Array.isArray(sc.assetsAdded)) {
    for (const a of sc.assetsAdded) state.assets.push(a);
  }
  if (Array.isArray(sc.assetsRemoved)) {
    state.assets = state.assets.filter(a => !sc.assetsRemoved.includes(a));
  }
  if (state.assets.length > 12) {
    state.assets = state.assets.slice(-12);
  }

  // worldStateDeltas: validator already stripped server-owned keys;
  // per-world enums also already enforced.
  if (sc.worldStateDeltas && typeof sc.worldStateDeltas === 'object') {
    for (const [k, v] of Object.entries(sc.worldStateDeltas)) {
      if (k === 'majorEvents') continue;
      state.worldState[k] = v;
    }
  }

  const evt = output?.worldImpacts?.majorEventLogged;
  if (evt) {
    if (!Array.isArray(state.worldState.majorEvents)) state.worldState.majorEvents = [];
    state.worldState.majorEvents.push(evt);
    if (state.worldState.majorEvents.length > 12) {
      state.worldState.majorEvents = state.worldState.majorEvents.slice(-12);
    }
  }

  // npcImpacts mutate npcStates
  for (const impact of (output?.npcImpacts ?? [])) {
    const id = impact.npcId;
    if (!id) continue;
    if (!state.npcStates[id]) {
      state.npcStates[id] = {
        location: '', status: '', motivationDelta: null, currentKnowledge: []
      };
    }
    const npc = state.npcStates[id];
    if (impact.locationDelta)   npc.location = impact.locationDelta;
    if (impact.statusDelta)     npc.status = impact.statusDelta;
    if (impact.motivationDelta) npc.motivationDelta = impact.motivationDelta;
    if (Array.isArray(impact.knowledgeGained)) {
      for (const k of impact.knowledgeGained) {
        npc.currentKnowledge.push({ ...k, source: `Beat ${state.turnNumber}` });
      }
    }
    // offScreenAction: narrative-only, not persisted on npc state
  }
}

function forcedTerminalCheck(state, bundle) {
  if (state.terminalState) return state.terminalState;

  if ((state.clockHours ?? 0) <= 0) {
    return { kind: 'time-up', summary: 'The clock ran out.' };
  }

  // Forced-end threats: any completed threat whose onComplete sets
  // antagonistPower or kills the king is treated as a forced ending.
  for (const [id, runtime] of Object.entries(state.threats || {})) {
    if (runtime.completed) {
      const bundleThreat = (bundle?.threats || []).find(t => t.id === id);
      const onCompleteDelta = bundleThreat?.onComplete?.worldStateDelta ?? {};
      const isForcedEnd =
        onCompleteDelta.kingStatus === 'dead' ||
        onCompleteDelta.antagonistPower === 'king' ||
        onCompleteDelta.antagonistPower === 'crowned';
      if (isForcedEnd) {
        const summary = bundleThreat.onComplete.majorEvent
          ?? `'${bundleThreat.displayName}' completed.`;
        return { kind: 'time-up', summary };
      }
    }
  }
  return null;
}

function updateRunHistoryFromTick(state, threatTick, eventTick) {
  if (!state.runHistory) return;

  if (threatTick?.completions) {
    for (const c of threatTick.completions) {
      if (!state.runHistory.threatsCompleted.includes(c.threatId)) {
        state.runHistory.threatsCompleted.push(c.threatId);
      }
    }
  }
  const allEvents = [
    ...(eventTick?.fired     ?? []),
    ...(eventTick?.cancelled ?? [])
  ];
  for (const ev of allEvents) {
    const strength = ev.outcome?.revelation?.strength ?? null;
    const bucket = (!strength || strength === 'silent')
      ? 'counterfactualsFiredSilent'
      : 'counterfactualsFiredKnown';
    if (!state.runHistory[bucket].includes(ev.eventId)) {
      state.runHistory[bucket].push(ev.eventId);
    }
  }
}

function finalizeRunHistory(state) {
  if (!state.runHistory) return;
  for (const [id, runtime] of Object.entries(state.threats || {})) {
    if (!runtime.completed) {
      const bucket = runtime.knownToPlayer ? 'threatsStopped' : 'threatsNeverLearned';
      if (!state.runHistory[bucket].includes(id)) {
        state.runHistory[bucket].push(id);
      }
    }
  }
}

function _failResponse(state, error) {
  return {
    state,
    response: null,
    log: { kind: 'error', error },
    validationStripped: [],
    retried: false
  };
}
