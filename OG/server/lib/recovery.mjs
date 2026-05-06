// Crash-recovery routine. Runs once on server boot.
// For each persisted game:
//   - Load state file. Read lastAppliedLogBeat.
//   - Walk the log forward; replay any turn entry whose beatNumber > lastAppliedLogBeat.
//   - Replay = overwrite the relevant state buckets with `intendedStateAfter`, bump lastAppliedLogBeat,
//     atomic-write state, then append an applied marker if missing.
// If state.beatNumber > highest logged beat: log a warning. State ahead of log indicates manual edit
// or disk corruption. Do not auto-correct.

import { listGameIds, readState, writeState } from './state-store.mjs';
import {
  scanUnappliedEntries,
  appendAppliedMarker,
  highestLoggedBeat
} from './beat-log.mjs';

/**
 * Runs recovery across every persisted game. Returns an array of per-game outcomes
 * for log-friendly summaries. Never throws on a single bad game — collects the error
 * and continues so one corrupted file does not block the others.
 */
export function recoverAllGames() {
  const ids = listGameIds();
  const results = [];
  for (const id of ids) {
    try {
      results.push(recoverGame(id));
    } catch (err) {
      results.push({ gameId: id, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Recover a single game. Returns:
 *   { gameId, ok: true, replayedBeats: number[], warning?: string }
 *   { gameId, ok: false, error: string }
 */
export function recoverGame(gameId) {
  const state = readState(gameId);
  if (!state) {
    return { gameId, ok: true, replayedBeats: [], warning: 'no state file' };
  }

  const lastApplied = typeof state.lastAppliedLogBeat === 'number' ? state.lastAppliedLogBeat : 0;
  const highest = highestLoggedBeat(gameId);

  if (state.beatNumber > highest) {
    // State is ahead of log — surface but do not auto-correct.
    return {
      gameId,
      ok: true,
      replayedBeats: [],
      warning: `state.beatNumber=${state.beatNumber} exceeds highest logged beat=${highest}; ` +
               `manual edit or disk corruption suspected`
    };
  }

  const pending = scanUnappliedEntries(gameId, lastApplied);
  if (pending.length === 0) {
    return { gameId, ok: true, replayedBeats: [] };
  }

  const replayed = [];
  let working = state;
  for (const { entry, hasAppliedMarker } of pending) {
    working = replayEntry(working, entry);
    writeState(gameId, working);
    if (!hasAppliedMarker) {
      appendAppliedMarker(gameId, entry.beatNumber);
    }
    replayed.push(entry.beatNumber);
  }

  return { gameId, ok: true, replayedBeats: replayed };
}

/**
 * Replay a single turn entry against an in-memory state object. Pure — caller writes the result.
 * intendedStateAfter is a snapshot of what the live state should look like after this beat.
 * We overwrite the runtime buckets that the turn flow mutates: beatNumber, lastAppliedLogBeat,
 * worldState, playerState, npcStates, plotTrajectory, forwardProjection, lastTurnAt.
 */
function replayEntry(currentState, turnEntry) {
  const after = turnEntry.intendedStateAfter;
  if (!after || typeof after !== 'object') {
    throw new Error(`beat ${turnEntry.beatNumber}: intendedStateAfter missing or invalid`);
  }
  return {
    ...currentState,
    beatNumber: after.beatNumber ?? turnEntry.beatNumber,
    lastAppliedLogBeat: turnEntry.beatNumber,
    lastTurnAt: after.lastTurnAt ?? turnEntry.ts ?? new Date().toISOString(),
    worldState: after.worldState ?? currentState.worldState,
    playerState: after.playerState ?? currentState.playerState,
    npcStates: after.npcStates ?? currentState.npcStates,
    plotTrajectory: after.plotTrajectory ?? currentState.plotTrajectory,
    forwardProjection: after.forwardProjection ?? currentState.forwardProjection ?? null
  };
}
