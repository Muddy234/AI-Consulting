// Phase 2 checkpoint smoke test.
// Run: node server/tools/test-validator.mjs
//   1. validates the existing ember-crown world bundle (must pass)
//   2. feeds a hand-crafted good model output (must pass)
//   3. feeds several hand-crafted bad model outputs (each must fail at a specific path)

import { loadWorldBundle, knownNpcIds } from '../lib/world-bundle.mjs';
import {
  validateWorldBundle,
  validateModelOutput,
  validateRuntimeState,
  formatErrors,
  firstError,
  RE_PROMPT_TEMPLATE
} from '../lib/validator.mjs';
import { DEFAULT_WORLD } from '../lib/config.mjs';

let pass = 0;
let fail = 0;

function assertPass(label, result) {
  if (result.ok) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}`);
    console.log(formatErrors(result.errors));
    fail++;
  }
}

function assertFailAt(label, result, expectedPathPrefix) {
  if (result.ok) {
    console.log(`FAIL  ${label}  (expected validation failure but got ok)`);
    fail++;
    return;
  }
  const hit = result.errors.find(e => e.path.startsWith(expectedPathPrefix));
  if (hit) {
    console.log(`PASS  ${label}  (rejected at ${hit.path}: ${hit.message})`);
    pass++;
  } else {
    console.log(`FAIL  ${label}  (no error at expected path "${expectedPathPrefix}")`);
    console.log(formatErrors(result.errors));
    fail++;
  }
}

// ----- 1. world bundle round-trip -----
const bundle = loadWorldBundle(DEFAULT_WORLD);
assertPass('world bundle (ember-crown) validates', validateWorldBundle(bundle));

const npcIds = knownNpcIds(bundle);
const ctx = { knownNpcIds: npcIds };

// ----- 2. good model output -----
const goodOutput = {
  worldImpacts: {
    stateChanges: {
      timeElapsed: '6 hours',
      worldStateDeltas: { timeOfDay: 'midday', cometStage: 'approaching' }
    },
    majorEventLogged: 'Player rode east with Sera.'
  },
  npcImpacts: [
    {
      npcId: 'sera',
      knowledgeGained: [
        { fact: 'Player accepted the summons', confidence: 'certain' }
      ]
    }
  ],
  narrativeResponse: {
    resolutionProse: 'You ride east. The road dust catches the comet-light.',
    isEnding: false,
    nextBeat: {
      title: 'II. The Eastern Road',
      intro: 'Dusk finds you at the edge of the Dead Pines.',
      choices: [
        { label: 'A', text: 'Press on through the night.', selfOther: -0.4, assertYield: -0.5 },
        { label: 'B', text: 'Make camp.',                  selfOther: -0.3, assertYield:  0.4 },
        { label: 'C', text: 'Question Sera about the king.', selfOther: 0.5, assertYield: -0.3 }
      ]
    }
  },
  forwardProjection: {
    next2BeatsTarget: 'Reach Vael\'s Reach by beat 4.',
    tonalAim: 'Tightening dread.',
    currentConfidence: 'high'
  },
  directorReasoning: 'Player advanced toward the keep.'
};
assertPass('good model output validates', validateModelOutput(goodOutput, ctx));

// ----- 3a. bad: wrong choice count -----
const badChoiceCount = JSON.parse(JSON.stringify(goodOutput));
badChoiceCount.narrativeResponse.nextBeat.choices.pop();
assertFailAt(
  'rejects choices.length !== 3',
  validateModelOutput(badChoiceCount, ctx),
  'narrativeResponse.nextBeat.choices'
);

// ----- 3b. bad: unknown npcId -----
const badNpc = JSON.parse(JSON.stringify(goodOutput));
badNpc.npcImpacts[0].npcId = 'random-villager';
assertFailAt(
  'rejects unknown npcId (background NPC)',
  validateModelOutput(badNpc, ctx),
  'npcImpacts[0].npcId'
);

// ----- 3c. server-owned field is silently stripped, not rejected -----
const stripTest = JSON.parse(JSON.stringify(goodOutput));
stripTest.worldImpacts.stateChanges.worldStateDeltas.worldDay = 99;
stripTest.worldImpacts.stateChanges.worldStateDeltas.cumulativeHoursElapsed = 999;
const stripResult = validateModelOutput(stripTest, ctx);
if (stripResult.ok &&
    stripTest.worldImpacts.stateChanges.worldStateDeltas.worldDay === undefined &&
    stripTest.worldImpacts.stateChanges.worldStateDeltas.cumulativeHoursElapsed === undefined) {
  console.log('PASS  server-owned fields silently stripped from worldStateDeltas');
  pass++;
} else {
  console.log('FAIL  server-owned-fields strip behavior incorrect');
  console.log(formatErrors(stripResult.errors || []));
  console.log('remaining keys:', Object.keys(stripTest.worldImpacts.stateChanges.worldStateDeltas));
  fail++;
}

// ----- 3d. bad: enum violation -----
const badEnum = JSON.parse(JSON.stringify(goodOutput));
badEnum.worldImpacts.stateChanges.worldStateDeltas.timeOfDay = 'twilight';
assertFailAt(
  'rejects unknown worldStateDeltas enum value',
  validateModelOutput(badEnum, ctx),
  'worldImpacts.stateChanges.worldStateDeltas.timeOfDay'
);

// ----- 3e. bad: missing required top-level field -----
const missing = JSON.parse(JSON.stringify(goodOutput));
delete missing.directorReasoning;
assertFailAt(
  'rejects missing directorReasoning',
  validateModelOutput(missing, ctx),
  'directorReasoning'
);

// ----- 3f. bad: all three choices in the same quadrant -----
const oneQuadrant = JSON.parse(JSON.stringify(goodOutput));
oneQuadrant.narrativeResponse.nextBeat.choices = [
  { label: 'A', text: 'Press on.', selfOther: -0.3, assertYield: -0.3 },
  { label: 'B', text: 'Force the gate.', selfOther: -0.7, assertYield: -0.5 },
  { label: 'C', text: 'Refuse aloud.', selfOther: -0.5, assertYield: -0.4 }
];
assertFailAt(
  'rejects choices that all share one quadrant',
  validateModelOutput(oneQuadrant, ctx),
  'narrativeResponse.nextBeat.choices'
);

// ----- 3f.2 bad: (0, 0) coordinate -----
const zeroCoord = JSON.parse(JSON.stringify(goodOutput));
zeroCoord.narrativeResponse.nextBeat.choices[0].selfOther = 0;
zeroCoord.narrativeResponse.nextBeat.choices[0].assertYield = 0;
assertFailAt(
  'rejects (0, 0) coordinate',
  validateModelOutput(zeroCoord, ctx),
  'narrativeResponse.nextBeat.choices[0]'
);

// ----- 3f.3 bad: coordinate out of range -----
const outOfRange = JSON.parse(JSON.stringify(goodOutput));
outOfRange.narrativeResponse.nextBeat.choices[1].selfOther = 1.5;
assertFailAt(
  'rejects coordinate > 1.0',
  validateModelOutput(outOfRange, ctx),
  'narrativeResponse.nextBeat.choices[1].selfOther'
);

// ----- 3f.4 bad: coordinate not on 0.10 grid -----
const offGrid = JSON.parse(JSON.stringify(goodOutput));
offGrid.narrativeResponse.nextBeat.choices[1].assertYield = 0.37;
assertFailAt(
  'rejects coordinate off the 0.10 step grid',
  validateModelOutput(offGrid, ctx),
  'narrativeResponse.nextBeat.choices[1].assertYield'
);

// ----- 3g. bad: bogus forwardProjection.currentConfidence -----
const badConf = JSON.parse(JSON.stringify(goodOutput));
badConf.forwardProjection.currentConfidence = 'maybe';
assertFailAt(
  'rejects unknown forwardProjection.currentConfidence',
  validateModelOutput(badConf, ctx),
  'forwardProjection.currentConfidence'
);

// ----- 3h. bad: ending without resolutionProse -----
const badEnding = JSON.parse(JSON.stringify(goodOutput));
badEnding.narrativeResponse.isEnding = true;
badEnding.narrativeResponse.resolutionProse = '';
assertFailAt(
  'rejects empty resolutionProse',
  validateModelOutput(badEnding, ctx),
  'narrativeResponse.resolutionProse'
);

// ----- 4. runtime state shape -----
const goodState = {
  gameId: 'g-test',
  worldName: DEFAULT_WORLD,
  beatNumber: 2,
  lastAppliedLogBeat: 1,
  worldState: {
    cumulativeHoursElapsed: 6,
    worldDay: 1,
    timeOfDay: 'midday',
    cometStage: 'approaching'
  },
  playerState: { location: 'Eastern Road', condition: 'tired' },
  npcStates: { sera: { knowledge: [] } },
  plotTrajectory: { majorEvents: [], lastForwardProjection: null }
};
assertPass('good runtime state validates', validateRuntimeState(goodState));

const badState = JSON.parse(JSON.stringify(goodState));
badState.worldState.timeOfDay = 'twilight';
assertFailAt(
  'rejects unknown timeOfDay in runtime state',
  validateRuntimeState(badState),
  'worldState.timeOfDay'
);

// ----- 5. re-prompt template smoke -----
const fe = firstError([{ path: 'npcImpacts[0].npcId', message: 'unknown id' }]);
const reprompt = RE_PROMPT_TEMPLATE(fe.path, fe.message);
if (reprompt.includes('npcImpacts[0].npcId') && reprompt.includes('unknown id')) {
  console.log('PASS  RE_PROMPT_TEMPLATE inlines path and message');
  pass++;
} else {
  console.log('FAIL  RE_PROMPT_TEMPLATE missing path or message');
  console.log(reprompt);
  fail++;
}

// ----- summary -----
console.log('');
console.log(`-- ${pass} passed, ${fail} failed --`);
process.exit(fail === 0 ? 0 : 1);
