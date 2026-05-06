// Phase 3 checkpoint smoke test.
// Run: node server/tools/test-state-and-recovery.mjs
//   1. atomic state write/read round-trip
//   2. beat-log append + tail + applied markers + scanUnapplied
//   3. lock FIFO ordering
//   4. simulated crash recovery (turn logged but not applied -> recover bumps state)

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, LOGS_DIR } from '../lib/config.mjs';
import {
  statePath, readState, writeState, deleteState, listGameIds
} from '../lib/state-store.mjs';
import {
  logPath, appendTurnEntry, appendAppliedMarker,
  tailTurnEntries, readAllRecords, scanUnappliedEntries,
  highestLoggedBeat, deleteLog
} from '../lib/beat-log.mjs';
import { acquire, isHeld, queueDepth } from '../lib/lock.mjs';
import { recoverGame } from '../lib/recovery.mjs';

let pass = 0;
let fail = 0;

function ok(label) { console.log(`PASS  ${label}`); pass++; }
function bad(label, detail) { console.log(`FAIL  ${label}`); if (detail) console.log('      ' + detail); fail++; }
function check(label, cond, detail) { cond ? ok(label) : bad(label, detail); }

const TEST_GAME = '__test__phase3';
const stateFile = statePath(TEST_GAME);
const logFile = logPath(TEST_GAME);

// Clean any prior test artifacts.
deleteState(TEST_GAME);
deleteLog(TEST_GAME);

// ----- 1. state-store atomic round-trip -----
const baseState = {
  gameId: TEST_GAME,
  worldName: 'ember-crown',
  createdAt: '2026-05-05T00:00:00.000Z',
  lastTurnAt: '2026-05-05T00:00:00.000Z',
  beatNumber: 1,
  lastAppliedLogBeat: 1,
  worldState: { worldDay: 1, cumulativeHoursElapsed: 0, timeOfDay: 'dawn', cometStage: 'approaching', majorEvents: [] },
  playerState: { location: "Wren's Hollow", condition: 'well' },
  npcStates: { sera: { location: "Wren's Hollow", status: 'alive' } },
  plotTrajectory: { currentPath: 'Companion' }
};
writeState(TEST_GAME, baseState);
check('writeState produces a file', fs.existsSync(stateFile));
check('no leftover .tmp file after writeState', !fs.existsSync(stateFile + '.tmp'));
const roundTripped = readState(TEST_GAME);
check('readState returns deep-equal state',
  JSON.stringify(roundTripped) === JSON.stringify(baseState));
check('listGameIds includes the test game', listGameIds().includes(TEST_GAME));

// ----- 2. beat-log basic operations -----
appendTurnEntry(TEST_GAME, {
  beatNumber: 1,
  playerChoice: null,
  modelOutput: '...opening beat...',
  intendedStateAfter: { ...baseState },
  notes: 'opening'
});
appendAppliedMarker(TEST_GAME, 1);

const beat2State = {
  ...baseState,
  beatNumber: 2,
  lastAppliedLogBeat: 2,
  lastTurnAt: '2026-05-05T01:00:00.000Z',
  worldState: { ...baseState.worldState, cumulativeHoursElapsed: 6, timeOfDay: 'midday' }
};
appendTurnEntry(TEST_GAME, {
  beatNumber: 2,
  playerChoice: 'A',
  modelInput: 'prompt',
  modelOutput: { narrativeResponse: { resolutionProse: 'You ride east.' } },
  stateBefore: baseState,
  intendedStateAfter: beat2State,
  tokensIn: 1234,
  tokensOut: 789
});
writeState(TEST_GAME, beat2State);
appendAppliedMarker(TEST_GAME, 2);

const records = readAllRecords(TEST_GAME);
check('log has 4 records (2 turns + 2 markers)', records.length === 4,
  `got ${records.length}`);

const turns = tailTurnEntries(TEST_GAME, 10);
check('tailTurnEntries returns turns only', turns.length === 2 && turns.every(t => t.kind === 'turn'));
check('tail is oldest-first', turns[0].beatNumber === 1 && turns[1].beatNumber === 2);

check('highestLoggedBeat reflects latest turn', highestLoggedBeat(TEST_GAME) === 2);

const noPending = scanUnappliedEntries(TEST_GAME, 2);
check('scanUnappliedEntries empty when state is current', noPending.length === 0);

// ----- 3. lock FIFO -----
(async () => {
  const order = [];
  const r1 = await acquire(TEST_GAME);
  check('lock initially held after first acquire', isHeld(TEST_GAME));

  const p2 = acquire(TEST_GAME).then(rel => { order.push('B'); return rel; });
  const p3 = acquire(TEST_GAME).then(rel => { order.push('C'); return rel; });

  // Allow microtask queue to settle.
  await Promise.resolve();
  check('two waiters queued', queueDepth(TEST_GAME) === 2,
    `queueDepth=${queueDepth(TEST_GAME)}`);

  order.push('A');
  r1();
  const r2 = await p2;
  r2();
  const r3 = await p3;
  r3();

  check('FIFO order A, B, C', JSON.stringify(order) === JSON.stringify(['A','B','C']),
    `got ${JSON.stringify(order)}`);
  check('lock released after all done', !isHeld(TEST_GAME));

  // ----- 4. simulated crash: turn 3 logged but state never updated -----
  appendTurnEntry(TEST_GAME, {
    beatNumber: 3,
    playerChoice: 'B',
    modelOutput: { narrativeResponse: { resolutionProse: 'Camp.' } },
    stateBefore: readState(TEST_GAME),
    intendedStateAfter: {
      ...readState(TEST_GAME),
      beatNumber: 3,
      lastTurnAt: '2026-05-05T02:00:00.000Z',
      worldState: { worldDay: 1, cumulativeHoursElapsed: 18, timeOfDay: 'dusk',
                    cometStage: 'approaching', majorEvents: ['Player camped.'] },
      plotTrajectory: { currentPath: 'Companion-cooled' }
    },
    tokensIn: 1500,
    tokensOut: 950
  });
  // No applied marker written -- simulates crash between log append and state write.

  const beforeRecover = readState(TEST_GAME);
  check('pre-recovery state still at beat 2', beforeRecover.beatNumber === 2);

  const pendingBefore = scanUnappliedEntries(TEST_GAME, beforeRecover.lastAppliedLogBeat);
  check('scanUnapplied surfaces the pending beat 3',
    pendingBefore.length === 1 &&
    pendingBefore[0].entry.beatNumber === 3 &&
    pendingBefore[0].hasAppliedMarker === false);

  const result = recoverGame(TEST_GAME);
  check('recoverGame reports replayed beat 3',
    result.ok && JSON.stringify(result.replayedBeats) === JSON.stringify([3]),
    JSON.stringify(result));

  const afterRecover = readState(TEST_GAME);
  check('post-recovery beatNumber bumped to 3', afterRecover.beatNumber === 3);
  check('post-recovery lastAppliedLogBeat = 3', afterRecover.lastAppliedLogBeat === 3);
  check('post-recovery worldState.cumulativeHoursElapsed = 18',
    afterRecover.worldState.cumulativeHoursElapsed === 18);
  check('post-recovery majorEvents includes camped event',
    Array.isArray(afterRecover.worldState.majorEvents) &&
    afterRecover.worldState.majorEvents.includes('Player camped.'));

  // After recovery, scanUnapplied should be empty.
  const pendingAfter = scanUnappliedEntries(TEST_GAME, afterRecover.lastAppliedLogBeat);
  check('post-recovery no pending entries', pendingAfter.length === 0);

  // Re-running recovery should be a no-op.
  const noop = recoverGame(TEST_GAME);
  check('second recoverGame is a no-op',
    noop.ok && noop.replayedBeats.length === 0);

  // ----- cleanup -----
  deleteState(TEST_GAME);
  deleteLog(TEST_GAME);
  check('cleanup removed state file', !fs.existsSync(stateFile));
  check('cleanup removed log file', !fs.existsSync(logFile));

  console.log('');
  console.log(`-- ${pass} passed, ${fail} failed --`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('test harness error:', err);
  process.exit(2);
});
