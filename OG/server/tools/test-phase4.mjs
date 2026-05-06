// Phase 4 checkpoint smoke test.
// Run: node server/tools/test-phase4.mjs
//   - parseTimeElapsed: lookup table coverage + unrecognized warning
//   - deriveTimeOfDay / deriveWorldDay
//   - applyDeltas: increments, server-owned strip, npcImpacts provenance, majorEvents cap
//   - prompt composer: in-scene vs off-screen scoping, climax block, ending block,
//                      output-schema reminder present, cumulativeHoursElapsed hidden

import { loadWorldBundle } from '../lib/world-bundle.mjs';
import {
  parseTimeElapsed, deriveTimeOfDay, deriveWorldDay, applyDeltas
} from '../lib/delta-applier.mjs';
import {
  composePrompt, scopeNpcs, isInScene, _internal
} from '../lib/prompt-composer.mjs';
import { MAJOR_EVENTS_CAP } from '../lib/config.mjs';

let pass = 0;
let fail = 0;
function ok(label) { console.log(`PASS  ${label}`); pass++; }
function bad(label, detail) { console.log(`FAIL  ${label}`); if (detail) console.log('      ' + detail); fail++; }
function check(label, cond, detail) { cond ? ok(label) : bad(label, detail); }

// ----- 1. parseTimeElapsed -----
const cases = [
  ['6 hours',           0,  6,  true],
  ['1 hour',            0,  1,  true],
  ['half a day',        0,  12, true],
  ['half day',          0,  12, true],
  ['2 days',            0,  48, true],
  ['a day',             0,  24, true],
  ['the next day',      0,  24, true],
  ['a few hours',       0,  4,  true],
  ['some hours',        0,  4,  true],
  ['several hours',     0,  4,  true],
  ['moments later',     0,  0,  true],
  ['shortly',           0,  0,  true],
  ['',                  0,  0,  true],
  [null,                0,  0,  true],
  ['quantum afternoon', 0,  0,  false]   // unrecognized
];
for (const [phrase, prior, hours, recognized] of cases) {
  const r = parseTimeElapsed(phrase, prior);
  check(`parseTimeElapsed(${JSON.stringify(phrase)}) -> ${hours}h, recognized=${recognized}`,
    r.hours === hours && r.recognized === recognized,
    `got ${JSON.stringify(r)}`);
}

// "the next morning" depends on current hour
const morn1 = parseTimeElapsed('the next morning', 3);   // 03:00 -> next 06:00 = +3
const morn2 = parseTimeElapsed('the next morning', 14);  // 14:00 -> next 06:00 = +16
check('"the next morning" at 03h -> +3h', morn1.hours === 3 && morn1.recognized);
check('"the next morning" at 14h -> +16h', morn2.hours === 16 && morn2.recognized);

// ----- 2. time-of-day derivation -----
const todCases = [
  [0,  'night'], [4, 'night'], [5, 'dawn'], [8, 'dawn'],
  [9, 'midday'], [16, 'midday'], [17, 'dusk'], [19, 'dusk'],
  [20, 'night'], [23, 'night'], [24, 'night'], [29, 'dawn']
];
for (const [h, expected] of todCases) {
  check(`deriveTimeOfDay(${h}) = ${expected}`, deriveTimeOfDay(h) === expected,
    `got ${deriveTimeOfDay(h)}`);
}

const dayCases = [[0, 1], [23, 1], [24, 2], [47, 2], [48, 3]];
for (const [h, expected] of dayCases) {
  check(`deriveWorldDay(${h}) = ${expected}`, deriveWorldDay(h) === expected);
}

// ----- 3. applyDeltas end-to-end -----
const world = loadWorldBundle('ember-crown');
const initial = {
  gameId: 'g',
  worldName: 'ember-crown',
  beatNumber: 1,
  lastAppliedLogBeat: 1,
  worldState: {
    worldDay: 1, cumulativeHoursElapsed: 0, timeOfDay: 'dawn',
    cometStage: 'approaching', kingStatus: 'declining', majorEvents: []
  },
  playerState: { location: "Wren's Hollow", condition: 'well' },
  npcStates: { sera: { location: "Wren's Hollow", status: 'alive', currentKnowledge: [] } },
  plotTrajectory: { currentPath: 'unset' }
};

const output = {
  worldImpacts: {
    stateChanges: {
      timeElapsed: '6 hours',
      worldStateDeltas: {
        cometStage: 'near-zenith',
        worldDay: 99,                      // server-owned, must be ignored
        cumulativeHoursElapsed: 1234       // server-owned, must be ignored
      }
    },
    majorEventLogged: 'Player rode east with Sera.'
  },
  npcImpacts: [
    { npcId: 'sera', statusDelta: 'weary',
      knowledgeGained: [{ fact: 'player carries the dream-mark', confidence: 'certain' }] },
    { npcId: 'high-advisor-halric', offScreenAction: 'Dispatched two more searchers.',
      knowledgeGained: [{ fact: 'the dreamer is moving east', confidence: 'suspected' }] }
  ],
  narrativeResponse: {
    resolutionProse: 'You ride.',
    isEnding: false,
    nextBeat: { title: 'II', intro: 'Dusk.', choices: [
      { label: 'A', text: 'Press on.',     selfOther: -0.4, assertYield: -0.5 },
      { label: 'B', text: 'Camp.',          selfOther: -0.3, assertYield:  0.4 },
      { label: 'C', text: 'Question Sera.', selfOther:  0.5, assertYield: -0.3 }
    ]}
  },
  forwardProjection: { next2BeatsTarget: 'Reach the keep', tonalAim: 'dread', currentConfidence: 'high' },
  directorReasoning: 'sentinel-reasoning'
};

const { state: nextState, warnings } = applyDeltas(initial, output, { beatNumber: 2, ts: '2026-05-05T01:00:00.000Z' });

check('applyDeltas: beatNumber bumped to 2', nextState.beatNumber === 2);
check('applyDeltas: lastAppliedLogBeat = 2', nextState.lastAppliedLogBeat === 2);
check('applyDeltas: cumulativeHoursElapsed += 6 -> 6', nextState.worldState.cumulativeHoursElapsed === 6);
check('applyDeltas: timeOfDay rederived from cumulative hours (6h -> dawn)',
  nextState.worldState.timeOfDay === 'dawn');
check('applyDeltas: worldDay still 1', nextState.worldState.worldDay === 1);
check('applyDeltas: cometStage delta applied', nextState.worldState.cometStage === 'near-zenith');
check('applyDeltas: server-owned worldDay ignored (still derived)', nextState.worldState.worldDay !== 99);
check('applyDeltas: cumulativeHoursElapsed not clobbered by model',
  nextState.worldState.cumulativeHoursElapsed === 6);
check('applyDeltas: majorEvent appended', nextState.worldState.majorEvents.includes('Player rode east with Sera.'));
check('applyDeltas: sera status updated', nextState.npcStates.sera.status === 'weary');
check('applyDeltas: sera knowledge tagged with provenance Beat 2',
  nextState.npcStates.sera.currentKnowledge.some(k =>
    k.fact === 'player carries the dream-mark' && k.source === 'Beat 2' && k.confidence === 'certain'));
check('applyDeltas: halric off-screen action recorded',
  nextState.npcStates['high-advisor-halric']?.lastOffScreenAction === 'Dispatched two more searchers.');
check('applyDeltas: halric knowledge tagged "Beat 2"',
  nextState.npcStates['high-advisor-halric']?.currentKnowledge?.[0]?.source === 'Beat 2');
check('applyDeltas: forwardProjection captured',
  nextState.forwardProjection.currentConfidence === 'high');
check('applyDeltas: lastIsEnding = false', nextState.lastIsEnding === false);
check('applyDeltas: directorReasoning recorded',
  nextState.plotTrajectory.lastDirectorReasoning === 'sentinel-reasoning');
check('applyDeltas: no warnings on recognized phrase', warnings.length === 0);
check('applyDeltas: original initial state untouched (immutable)',
  initial.beatNumber === 1 && initial.worldState.cumulativeHoursElapsed === 0);

// Unrecognized phrase yields a warning, time stays put.
const oddOutput = { ...output, worldImpacts: {
  stateChanges: { timeElapsed: 'quantum tuesday', worldStateDeltas: {} },
  majorEventLogged: null
}};
const oddResult = applyDeltas(initial, oddOutput, { beatNumber: 2, ts: 'x' });
check('applyDeltas: unrecognized timeElapsed produces a warning', oddResult.warnings.length === 1);
check('applyDeltas: unrecognized adds 0 hours', oddResult.state.worldState.cumulativeHoursElapsed === 0);

// majorEvents rolling cap
let stateForCap = JSON.parse(JSON.stringify(initial));
for (let i = 1; i <= MAJOR_EVENTS_CAP + 5; i++) {
  const r = applyDeltas(stateForCap, {
    worldImpacts: { stateChanges: { timeElapsed: '1 hour' }, majorEventLogged: `event ${i}` },
    npcImpacts: [], narrativeResponse: {},
    forwardProjection: {}, directorReasoning: ''
  }, { beatNumber: 1 + i, ts: 'x' });
  stateForCap = r.state;
}
check(`majorEvents capped at ${MAJOR_EVENTS_CAP}`,
  stateForCap.worldState.majorEvents.length === MAJOR_EVENTS_CAP,
  `got ${stateForCap.worldState.majorEvents.length}`);
check('majorEvents oldest dropped (event 1 not in tail)',
  !stateForCap.worldState.majorEvents.includes('event 1'));
check('majorEvents newest retained',
  stateForCap.worldState.majorEvents.includes(`event ${MAJOR_EVENTS_CAP + 5}`));

// ----- 4. prompt composer scoping -----
check('isInScene: same string', isInScene("Wren's Hollow", "Wren's Hollow"));
check('isInScene: substring match', isInScene("Wren's Hollow (own home)", "Wren's Hollow"));
check('isInScene: disjoint', !isInScene("Eastern road", "Vael's Reach keep"));

const scoped = scopeNpcs(world, nextState);
check('scopeNpcs: sera in-scene (player at Wren\'s Hollow, sera at Wren\'s Hollow)',
  scoped.inScene.some(n => n.id === 'sera'));
check('scopeNpcs: halric off-screen', scoped.offScreen.some(n => n.id === 'high-advisor-halric'));
check('scopeNpcs: in-scene includes currentKnowledge',
  scoped.inScene.find(n => n.id === 'sera').currentKnowledge.length > 0);
check('scopeNpcs: off-screen entries omit knowledge field',
  !('currentKnowledge' in scoped.offScreen.find(n => n.id === 'high-advisor-halric')));

// Compose a normal-pacing prompt
const prompt1 = composePrompt({
  world, state: nextState, recentTurnEntries: [], playerChoice: 'A'
});
check('composePrompt: includes voice block', prompt1.includes('# VOICE'));
check('composePrompt: includes structural objective', prompt1.includes('STRUCTURAL OBJECTIVE'));
check('composePrompt: includes world constraints', prompt1.includes('WORLD CONSTRAINTS'));
check('composePrompt: includes NPC invention rules', prompt1.includes('NPC INVENTION RULES'));
check('composePrompt: includes knowledge isolation rule', prompt1.includes('KNOWLEDGE ISOLATION'));
check('composePrompt: includes output schema reminder', prompt1.includes('OUTPUT SCHEMA'));
// The field name appears in the OUTPUT_SCHEMA reminder ("Do NOT set ... cumulativeHoursElapsed");
// what we verify is that no *current value* of the counter leaks into the CURRENT STATE block.
const currentStateSection = prompt1.split('# CURRENT STATE')[1]?.split('---')[0] ?? '';
check('composePrompt: hides cumulativeHoursElapsed value from CURRENT STATE block',
  !currentStateSection.includes('cumulativeHoursElapsed'),
  `CURRENT STATE excerpt: ${currentStateSection.slice(0, 200)}`);
check('composePrompt: surfaces sera knowledge in scope',
  prompt1.includes('player carries the dream-mark'));
check('composePrompt: does NOT surface halric knowledge (off-screen)',
  !prompt1.includes('the dreamer is moving east'));
check('composePrompt: includes player choice', prompt1.includes("PLAYER'S MOST RECENT CHOICE"));
check('composePrompt: NO climax block before climaxByBeat',
  !prompt1.includes(_internal.CLIMAX_REQUIRED_BLOCK));

// Past-pacing-budget triggers climax block.
const climaxState = { ...nextState, beatNumber: 6 };
const prompt2 = composePrompt({
  world, state: climaxState, recentTurnEntries: [], playerChoice: 'A'
});
check('composePrompt: injects CLIMAX REQUIRED at beat 6',
  prompt2.includes('[CLIMAX REQUIRED]'));

// Ending escalation forced.
const prompt3 = composePrompt({
  world, state: climaxState, recentTurnEntries: [], playerChoice: 'A',
  opts: { ending: true }
});
check('composePrompt: opts.ending injects ENDING REQUIRED',
  prompt3.includes('[ENDING REQUIRED'));
check('composePrompt: ending block replaces climax block (only one shown)',
  prompt3.includes('[ENDING REQUIRED') && !prompt3.includes('[CLIMAX REQUIRED]'));

// Forward-projection framing only when set.
const noFp = { ...nextState, forwardProjection: null };
const prompt4 = composePrompt({
  world, state: noFp, recentTurnEntries: [], playerChoice: 'A'
});
check('composePrompt: omits forward-projection block when null',
  !prompt4.includes('PRIOR FORWARD PROJECTION'));

console.log('');
console.log(`-- ${pass} passed, ${fail} failed --`);
process.exit(fail === 0 ? 0 : 1);
