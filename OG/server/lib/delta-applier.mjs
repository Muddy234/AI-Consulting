// Applies a validated model output to runtime state.
// Pure: takes prevState + output + meta, returns nextState. Caller persists it.
// Time advancement is fully deterministic: model returns a phrase, server parses to hours.

import { MAJOR_EVENTS_CAP } from './config.mjs';
import { SERVER_OWNED_WORLD_FIELDS } from './schema.mjs';

// ----- time parsing -----

/**
 * Parses a model-supplied timeElapsed phrase to an integer number of hours.
 * Returns { hours, recognized }. Unrecognized phrases yield { hours: 0, recognized: false }
 * so callers can log a warning. Special "by morning" phrasings need cumulativeHoursElapsed
 * context — pass it in to compute the boundary distance.
 */
export function parseTimeElapsed(phrase, cumulativeHoursElapsed = 0) {
  if (phrase === null || phrase === undefined) {
    return { hours: 0, recognized: true };  // null = no time passed (allowed)
  }
  if (typeof phrase !== 'string') {
    return { hours: 0, recognized: false };
  }
  const s = phrase.trim().toLowerCase();
  if (s === '') return { hours: 0, recognized: true };

  // "N hours" / "N hour"
  let m = s.match(/^(\d+)\s*hour(s)?$/);
  if (m) return { hours: parseInt(m[1], 10), recognized: true };

  // "half a day" / "half day"
  if (s === 'half a day' || s === 'half day') return { hours: 12, recognized: true };

  // "N days" / "N day"
  m = s.match(/^(\d+)\s*day(s)?$/);
  if (m) return { hours: parseInt(m[1], 10) * 24, recognized: true };

  // "a day" / "the next day" / "next day" / "one day"
  if (['a day', 'the next day', 'next day', 'one day'].includes(s)) {
    return { hours: 24, recognized: true };
  }

  // "the next morning" / "by morning" / "next morning" -> advance to next 06:00 boundary (dawn start)
  if (['the next morning', 'by morning', 'next morning'].includes(s)) {
    const hourOfDay = ((cumulativeHoursElapsed % 24) + 24) % 24;
    const advance = hourOfDay < 6 ? (6 - hourOfDay) : (24 - hourOfDay + 6);
    return { hours: advance, recognized: true };
  }

  // "a few hours" / "some hours" / "several hours"
  if (['a few hours', 'some hours', 'several hours'].includes(s)) {
    return { hours: 4, recognized: true };
  }

  // "moments later" / "shortly" / "a moment later" / "instantly" -> 0
  if (['moments later', 'shortly', 'a moment later', 'instantly', 'immediately'].includes(s)) {
    return { hours: 0, recognized: true };
  }

  return { hours: 0, recognized: false };
}

/** Maps cumulativeHoursElapsed to one of the timeOfDay enum values. */
export function deriveTimeOfDay(cumulativeHoursElapsed) {
  const h = ((cumulativeHoursElapsed % 24) + 24) % 24;
  if (h < 5) return 'night';
  if (h < 9) return 'dawn';
  if (h < 17) return 'midday';
  if (h < 20) return 'dusk';
  return 'night';
}

/** worldDay = floor(hours / 24) + 1. Day numbering starts at 1. */
export function deriveWorldDay(cumulativeHoursElapsed) {
  return Math.floor(cumulativeHoursElapsed / 24) + 1;
}

// ----- delta application -----

/**
 * Applies a validated modelOutput to prevState, producing nextState.
 * Mutates a deep clone of prevState — the original is left untouched.
 *
 * @param {object} prevState - current runtime state
 * @param {object} output - validated model output
 * @param {object} meta - { beatNumber, ts }  (server-owned, never trusted from model)
 * @returns { state, warnings: string[] }
 */
export function applyDeltas(prevState, output, meta) {
  const warnings = [];
  const state = JSON.parse(JSON.stringify(prevState));

  state.beatNumber = meta.beatNumber;
  state.lastAppliedLogBeat = meta.beatNumber;
  state.lastTurnAt = meta.ts || new Date().toISOString();

  // ----- worldImpacts: time + state deltas + major event -----
  const wi = output.worldImpacts || {};
  const sc = wi.stateChanges || {};

  // Time advancement
  const { hours, recognized } = parseTimeElapsed(
    sc.timeElapsed,
    state.worldState?.cumulativeHoursElapsed ?? 0
  );
  if (!recognized) {
    warnings.push(`unrecognized timeElapsed phrase: ${JSON.stringify(sc.timeElapsed)} (treated as 0 hours)`);
  }
  if (!state.worldState) state.worldState = { cumulativeHoursElapsed: 0, worldDay: 1, majorEvents: [] };
  state.worldState.cumulativeHoursElapsed = (state.worldState.cumulativeHoursElapsed || 0) + hours;
  state.worldState.worldDay = deriveWorldDay(state.worldState.cumulativeHoursElapsed);
  state.worldState.timeOfDay = deriveTimeOfDay(state.worldState.cumulativeHoursElapsed);

  // worldStateDeltas — server-owned fields stripped defensively (validator already does this).
  if (sc.worldStateDeltas && typeof sc.worldStateDeltas === 'object') {
    for (const [k, v] of Object.entries(sc.worldStateDeltas)) {
      if (SERVER_OWNED_WORLD_FIELDS.has(k)) continue;
      state.worldState[k] = v;
    }
  }

  // majorEvent (rolling buffer cap)
  if (typeof wi.majorEventLogged === 'string' && wi.majorEventLogged.trim() !== '') {
    if (!Array.isArray(state.worldState.majorEvents)) state.worldState.majorEvents = [];
    state.worldState.majorEvents.push(wi.majorEventLogged.trim());
    if (state.worldState.majorEvents.length > MAJOR_EVENTS_CAP) {
      state.worldState.majorEvents = state.worldState.majorEvents.slice(-MAJOR_EVENTS_CAP);
    }
  }

  // ----- npcImpacts -----
  if (!state.npcStates || typeof state.npcStates !== 'object') state.npcStates = {};
  if (Array.isArray(output.npcImpacts)) {
    for (const imp of output.npcImpacts) {
      const id = imp.npcId;
      if (!state.npcStates[id]) {
        state.npcStates[id] = { currentKnowledge: [] };
      }
      const npc = state.npcStates[id];
      if (typeof imp.locationDelta === 'string') npc.location = imp.locationDelta;
      if (typeof imp.statusDelta === 'string') npc.status = imp.statusDelta;
      if (typeof imp.motivationDelta === 'string') npc.motivationDelta = imp.motivationDelta;
      if (typeof imp.offScreenAction === 'string') npc.lastOffScreenAction = imp.offScreenAction;

      if (Array.isArray(imp.knowledgeGained)) {
        if (!Array.isArray(npc.currentKnowledge)) npc.currentKnowledge = [];
        for (const k of imp.knowledgeGained) {
          npc.currentKnowledge.push({
            fact: k.fact,
            confidence: k.confidence || 'certain',
            source: `Beat ${meta.beatNumber}`
          });
        }
      }
    }
  }

  // ----- narrative + plot trajectory + forward projection -----
  const nr = output.narrativeResponse || {};
  // playerState updates the model can express via knowledgeGained/locationDelta come through
  // npcImpacts only; player-state mutation in v1 is bookkeeping (location stays player-driven).
  // We do, however, capture isEnding so the climax/ending logic can read it.
  state.lastIsEnding = !!nr.isEnding;

  if (output.forwardProjection && typeof output.forwardProjection === 'object') {
    state.forwardProjection = {
      next2BeatsTarget: output.forwardProjection.next2BeatsTarget || null,
      tonalAim: output.forwardProjection.tonalAim || null,
      currentConfidence: output.forwardProjection.currentConfidence || null
    };
  }

  if (typeof output.directorReasoning === 'string') {
    if (!state.plotTrajectory || typeof state.plotTrajectory !== 'object') state.plotTrajectory = {};
    state.plotTrajectory.lastDirectorReasoning = output.directorReasoning;
  }

  return { state, warnings };
}
