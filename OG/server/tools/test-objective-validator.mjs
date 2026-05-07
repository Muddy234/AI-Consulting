// Phase B test suite for the objective validator.
// Run: node server/tools/test-objective-validator.mjs
//
// Covers schema-level rejections (delegated to ajv via the validator) and
// semantic rules: lethality gate, server-owned-field stripping, link
// correspondence and uniqueness, fireAtHour > elapsed, macro-threat id
// collision and per-game cap, per-world enum enforcement, npc reference
// resolution, unlocksThreats reference resolution.

import {
  validateModelOutput,
  validateRuntimeState,
  formatErrors,
  firstError,
  RE_PROMPT_TEMPLATE,
  MODEL_AUTHORED_THREAT_CAP
} from '../lib/objective-validator.mjs';

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}${detail ? '\n  ' + detail : ''}`); fail++; }
}

function assertPass(label, result) {
  ok(label, result.ok === true,
     result.ok ? '' : 'expected ok but got errors:\n' + formatErrors(result.errors));
}

function assertFailAt(label, result, expectedPathPrefix) {
  if (result.ok) {
    ok(label, false, `expected failure at "${expectedPathPrefix}" but got ok`);
    return;
  }
  const hit = (result.errors || []).find(e => e.path.startsWith(expectedPathPrefix));
  if (hit) {
    ok(`${label}  (rejected at ${hit.path})`, true);
  } else {
    ok(label, false,
       `no error at expected path "${expectedPathPrefix}". Got:\n` + formatErrors(result.errors));
  }
}

// ---------- fixtures ----------

function makeBundle() {
  return {
    worldName: 'ember-crown',
    startingClocks: { clockHours: 96, distanceToKing: 100 },
    worldStateEnums: {
      timeOfDay:       ['dawn', 'midday', 'dusk', 'night'],
      cometStage:      ['approaching', 'near-zenith', 'zenith', 'passing', 'passed'],
      kingStatus:      ['declining', 'dying', 'near-death', 'dead'],
      crownStatus:     ['dormant', 'held', 'activated', 'destroyed'],
      antagonistPower: ['advisor', 'regent', 'crowned', 'king', 'dead']
    },
    characters: [
      { id: 'sera',   name: 'Sera' },
      { id: 'halric', name: 'Halric' }
    ],
    threats: [
      { id: 'halric-coronation', displayName: 'Halric\'s Plan', duration: 96 }
    ]
  };
}

function makeState(overrides = {}) {
  const base = {
    gameId: 'ember-test-1',
    worldName: 'ember-crown',
    turnNumber: 4,
    lastAppliedLogTurn: 4,
    clockHours: 56,            // 40 hours elapsed
    distanceToKing: 47,
    condition: 'tired',
    location: 'Eastern road',
    assets: ['hunting knife', 'cloak', 'ally:sera'],
    lastChoiceRisk: 'risky',
    worldState: {
      timeOfDay: 'dusk', cometStage: 'near-zenith',
      kingStatus: 'dying', crownStatus: 'dormant', antagonistPower: 'advisor',
      majorEvents: ['Sera met player at gate']
    },
    threats: {
      'halric-coronation': {
        progress: 36, currentPhase: 'Brewing', slowedBy: 0,
        knownToPlayer: true, revealedAtHour: 14,
        completed: false, completedAt: null, authorSource: 'authored'
      }
    },
    scheduledEvents: [],
    pendingRevelations: [],
    playerKnowledge: {
      knownThreatIds: ['halric-coronation'],
      witnessedEvents: [], rumors: [], investigatedFacts: []
    },
    npcStates: {
      sera: {
        location: 'Eastern road', status: 'wary', motivationDelta: null,
        currentKnowledge: [{ fact: 'king is being poisoned', confidence: 'certain', source: 'authored' }]
      }
    },
    runHistory: {
      threatsCompleted: [], threatsStopped: [], threatsNeverLearned: [],
      counterfactualsFiredKnown: [], counterfactualsFiredSilent: []
    },
    terminalState: null
  };
  return { ...base, ...overrides };
}

function makeOutput() {
  return {
    worldImpacts: {
      stateChanges: { clockHoursDelta: 12, distanceDelta: -8 },
      majorEventLogged: 'Player and Sera made camp.'
    },
    npcImpacts: [{ npcId: 'sera', statusDelta: 'weary' }],
    narrativeResponse: {
      resolutionProse: { segments: [
        { type: 'text', content: 'Sera glances toward ' },
        { type: 'link', id: 'l1', content: 'the road', linkType: 'clue' },
        { type: 'text', content: '. Her hand rests on her hilt.' }
      ]},
      resolutionLinkContents: {
        l1: { content: 'A column of dust on the eastern road. Riders.' }
      },
      isEnding: false,
      terminalState: null,
      nextBeat: {
        title: 'IV. The Soldier in the Pines',
        intro: { segments: [{ type: 'text', content: 'The pines close behind you.' }] },
        introLinkContents: {},
        choices: [
          { label: 'A', text: 'Push on through the night.', risk: 'risky' },
          { label: 'B', text: 'Make camp here.', risk: 'controlled' }
        ]
      }
    },
    forwardProjection: { tonalAim: 'rising dread', currentConfidence: 'moderate' },
    directorReasoning: 'Player diverged at bandit pass.'
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- schema-level (via ajv) ----------

console.log('\n--- schema-level (ajv-driven) ---');

const bundle = makeBundle();
const state  = makeState();

assertPass('good output passes', validateModelOutput(makeOutput(), { state, bundle }));
assertPass('good runtime state passes', validateRuntimeState(state));

{
  const o = makeOutput();
  o.worldImpacts.stateChanges.clockHoursDelta = -3;
  assertFailAt('clockHoursDelta=-3 rejected',
    validateModelOutput(o, { state, bundle }),
    'worldImpacts.stateChanges.clockHoursDelta');
}
{
  const o = makeOutput();
  o.worldImpacts.stateChanges.clockHoursDelta = 30;
  assertFailAt('clockHoursDelta=30 rejected',
    validateModelOutput(o, { state, bundle }),
    'worldImpacts.stateChanges.clockHoursDelta');
}
{
  const o = makeOutput();
  o.worldImpacts.stateChanges.distanceDelta = -25;
  assertFailAt('distanceDelta=-25 rejected',
    validateModelOutput(o, { state, bundle }),
    'worldImpacts.stateChanges.distanceDelta');
}
{
  const o = makeOutput();
  o.narrativeResponse.nextBeat.choices = [{ label: 'A', text: 'only one', risk: 'controlled' }];
  assertFailAt('1 choice rejected',
    validateModelOutput(o, { state, bundle }),
    'narrativeResponse.nextBeat.choices');
}
{
  const o = makeOutput();
  o.narrativeResponse.nextBeat.choices = [
    { label: 'A', text: 'a', risk: 'controlled' },
    { label: 'B', text: 'b', risk: 'risky' },
    { label: 'C', text: 'c', risk: 'desperate' },
    { label: 'D', text: 'd', risk: 'controlled' }
  ];
  assertPass('4 choices accepted', validateModelOutput(o, { state, bundle }));
}
{
  const o = makeOutput();
  o.narrativeResponse.resolutionProse.segments[1].linkType = 'invalid-type';
  assertFailAt('bad linkType rejected',
    validateModelOutput(o, { state, bundle }),
    'narrativeResponse.resolutionProse.segments[1].linkType');
}
{
  const o = makeOutput();
  o.narrativeResponse.nextBeat.choices[0].risk = 'reckless';
  assertFailAt('bad risk enum rejected',
    validateModelOutput(o, { state, bundle }),
    'narrativeResponse.nextBeat.choices[0].risk');
}
{
  const s = makeState({ clockHours: 999 });
  assertFailAt('runtime clockHours=999 rejected',
    validateRuntimeState(s),
    'clockHours');
}
{
  const s = makeState({ assets: Array(13).fill('x') });
  assertFailAt('runtime 13 assets rejected',
    validateRuntimeState(s),
    'assets');
}
{
  const o = makeOutput();
  o.narrativeResponse.isEnding = true;
  // leave nextBeat present and terminalState null -- inconsistent
  assertFailAt('isEnding=true with nextBeat present rejected',
    validateModelOutput(o, { state, bundle }),
    'narrativeResponse');
}

// ---------- lethality gate ----------

console.log('\n--- lethality gate ---');

{
  const desperateState = makeState({ lastChoiceRisk: 'desperate' });
  const o = makeOutput();
  o.narrativeResponse.isEnding = true;
  o.narrativeResponse.terminalState = { kind: 'killed', summary: 'A blade in the dark.' };
  o.narrativeResponse.nextBeat = null;
  assertPass('killed + desperate accepted',
    validateModelOutput(o, { state: desperateState, bundle }));
}
{
  const controlledState = makeState({ lastChoiceRisk: 'controlled' });
  const o = makeOutput();
  o.narrativeResponse.isEnding = true;
  o.narrativeResponse.terminalState = { kind: 'killed', summary: 'A blade in the dark.' };
  o.narrativeResponse.nextBeat = null;
  assertFailAt('killed + controlled rejected',
    validateModelOutput(o, { state: controlledState, bundle }),
    'narrativeResponse.terminalState.kind');
}
{
  const riskyState = makeState({ lastChoiceRisk: 'risky' });
  const o = makeOutput();
  o.narrativeResponse.isEnding = true;
  o.narrativeResponse.terminalState = { kind: 'trapped', summary: 'The pit closes.' };
  o.narrativeResponse.nextBeat = null;
  assertFailAt('trapped + risky rejected',
    validateModelOutput(o, { state: riskyState, bundle }),
    'narrativeResponse.terminalState.kind');
}
{
  // reached-king does NOT require desperate
  const controlledState = makeState({ lastChoiceRisk: 'controlled', distanceToKing: 4 });
  const o = makeOutput();
  o.narrativeResponse.isEnding = true;
  o.narrativeResponse.terminalState = { kind: 'reached-king', summary: 'You stand at his bedside.' };
  o.narrativeResponse.nextBeat = null;
  assertPass('reached-king + controlled accepted (gate does not apply)',
    validateModelOutput(o, { state: controlledState, bundle }));
}
{
  // non-lethal "surprise" on controlled: heavy condition change but no terminal
  const controlledState = makeState({ lastChoiceRisk: 'controlled' });
  const o = makeOutput();
  o.worldImpacts.stateChanges.conditionChange = 'wounded';
  o.worldImpacts.stateChanges.assetsRemoved = ['horse'];
  assertPass('non-lethal surprise on controlled accepted',
    validateModelOutput(o, { state: controlledState, bundle }));
}

// ---------- terminal consistency ----------

console.log('\n--- terminal-state consistency vs state ---');

{
  // reached-king: state distanceToKing=4, delta=0 -> post=4 <= 5 -> accept
  const s = makeState({ distanceToKing: 4, lastChoiceRisk: 'controlled' });
  const o = makeOutput();
  o.worldImpacts.stateChanges.distanceDelta = 0;
  o.narrativeResponse.isEnding = true;
  o.narrativeResponse.terminalState = { kind: 'reached-king', summary: 'You stand at his bedside.' };
  o.narrativeResponse.nextBeat = null;
  assertPass('reached-king with post-distance=4 accepted',
    validateModelOutput(o, { state: s, bundle }));
}
{
  // reached-king: state=20, delta=-5 -> post=15 > 5 -> reject
  const s = makeState({ distanceToKing: 20, lastChoiceRisk: 'controlled' });
  const o = makeOutput();
  o.worldImpacts.stateChanges.distanceDelta = -5;
  o.narrativeResponse.isEnding = true;
  o.narrativeResponse.terminalState = { kind: 'reached-king', summary: 'too soon' };
  o.narrativeResponse.nextBeat = null;
  assertFailAt('reached-king with post-distance=15 rejected',
    validateModelOutput(o, { state: s, bundle }),
    'narrativeResponse.terminalState.kind');
}
{
  // time-up: state clockHours=12, delta=20 -> post=-8 <= 0 -> accept
  const s = makeState({ clockHours: 12 });
  const o = makeOutput();
  o.worldImpacts.stateChanges.clockHoursDelta = 20;
  o.narrativeResponse.isEnding = true;
  o.narrativeResponse.terminalState = { kind: 'time-up', summary: 'The bells toll.' };
  o.narrativeResponse.nextBeat = null;
  assertPass('time-up with post-clock=-8 accepted',
    validateModelOutput(o, { state: s, bundle }));
}
{
  // time-up: state=20, delta=10 -> post=10 > 0 -> reject
  const s = makeState({ clockHours: 20 });
  const o = makeOutput();
  o.worldImpacts.stateChanges.clockHoursDelta = 10;
  o.narrativeResponse.isEnding = true;
  o.narrativeResponse.terminalState = { kind: 'time-up', summary: 'too soon' };
  o.narrativeResponse.nextBeat = null;
  assertFailAt('time-up with post-clock=10 rejected',
    validateModelOutput(o, { state: s, bundle }),
    'narrativeResponse.terminalState.kind');
}

// ---------- server-owned field stripping ----------

console.log('\n--- server-owned field stripping ---');

{
  const o = makeOutput();
  o.worldImpacts.stateChanges.worldStateDeltas = {
    clockHours: 50,             // server-owned -- strip
    distanceToKing: 30,         // server-owned -- strip
    turnNumber: 99,             // server-owned -- strip
    kingStatus: 'dying'         // legitimate -- keep
  };
  const result = validateModelOutput(o, { state, bundle });
  ok('result is ok after silent strip', result.ok === true,
     result.ok ? '' : formatErrors(result.errors));
  ok('clockHours stripped from worldStateDeltas',
     !('clockHours' in o.worldImpacts.stateChanges.worldStateDeltas));
  ok('distanceToKing stripped from worldStateDeltas',
     !('distanceToKing' in o.worldImpacts.stateChanges.worldStateDeltas));
  ok('turnNumber stripped from worldStateDeltas',
     !('turnNumber' in o.worldImpacts.stateChanges.worldStateDeltas));
  ok('kingStatus retained in worldStateDeltas',
     o.worldImpacts.stateChanges.worldStateDeltas.kingStatus === 'dying');
  ok('stripped report names all 3 fields',
     result.stripped.length === 3,
     `stripped: ${JSON.stringify(result.stripped)}`);
}

// ---------- link correspondence + uniqueness ----------

console.log('\n--- link correspondence + uniqueness ---');

{
  const o = makeOutput();
  // link 'l1' in segments but missing from contents
  delete o.narrativeResponse.resolutionLinkContents.l1;
  assertFailAt('link in segments without contents rejected',
    validateModelOutput(o, { state, bundle }),
    'narrativeResponse.resolutionLinkContents.l1');
}
{
  const o = makeOutput();
  // contents key 'orphan' with no matching segment
  o.narrativeResponse.resolutionLinkContents.orphan = { content: 'orphaned content' };
  assertFailAt('contents key without segment rejected',
    validateModelOutput(o, { state, bundle }),
    'narrativeResponse.resolutionLinkContents.orphan');
}
{
  const o = makeOutput();
  // duplicate 'l1' link id within segments
  o.narrativeResponse.resolutionProse.segments.push(
    { type: 'link', id: 'l1', content: 'duplicate', linkType: 'flavor' }
  );
  assertFailAt('duplicate link id within prose rejected',
    validateModelOutput(o, { state, bundle }),
    'narrativeResponse.resolutionProse.segments');
}
{
  // hyperlinks in nextBeat.intro must also correlate
  const o = makeOutput();
  o.narrativeResponse.nextBeat.intro = { segments: [
    { type: 'text', content: 'Through the trees, ' },
    { type: 'link', id: 'i1', content: 'a banner', linkType: 'threat-reveal' },
    { type: 'text', content: ' moves with the wind.' }
  ]};
  // forget to add introLinkContents.i1
  assertFailAt('nextBeat link missing contents rejected',
    validateModelOutput(o, { state, bundle }),
    'narrativeResponse.nextBeat.introLinkContents.i1');
}

// ---------- fireAtHour > elapsed ----------

console.log('\n--- scheduled event fireAtHour ---');

{
  // state.clockHours = 56 -> elapsed = 96-56 = 40
  const o = makeOutput();
  o.worldImpacts.scheduledEventsToAdd = [{
    id: 'past-event',
    fireAtHour: 30,            // <= elapsed -- reject
    outcomeOnFire: { revelation: { strength: 'quiet', delayHours: 12, content: '...' } }
  }];
  assertFailAt('fireAtHour <= elapsed rejected',
    validateModelOutput(o, { state, bundle }),
    'worldImpacts.scheduledEventsToAdd[0].fireAtHour');
}
{
  const o = makeOutput();
  o.worldImpacts.scheduledEventsToAdd = [{
    id: 'future-event',
    fireAtHour: 60,            // > 40 elapsed -- accept
    outcomeOnFire: { revelation: { strength: 'quiet', delayHours: 12, content: '...' } }
  }];
  assertPass('fireAtHour > elapsed accepted',
    validateModelOutput(o, { state, bundle }));
}
{
  // boundary: fireAtHour exactly equals elapsed -- reject (must be strictly greater)
  const o = makeOutput();
  o.worldImpacts.scheduledEventsToAdd = [{
    id: 'boundary-event',
    fireAtHour: 40,
    outcomeOnFire: { revelation: { strength: 'quiet', delayHours: 12, content: '...' } }
  }];
  assertFailAt('fireAtHour == elapsed rejected (must be strictly greater)',
    validateModelOutput(o, { state, bundle }),
    'worldImpacts.scheduledEventsToAdd[0].fireAtHour');
}

// ---------- macro-threat rules ----------

console.log('\n--- macro-threat authoring ---');

{
  // id collision with existing
  const o = makeOutput();
  o.worldImpacts.macroThreatsToAdd = [{
    id: 'halric-coronation',     // already exists
    displayName: 'Dup', duration: 24,
    phases: [{ atProgress: 0, label: 'p' }],
    onComplete: { majorEvent: 'x' }
  }];
  assertFailAt('macro-threat id collision rejected',
    validateModelOutput(o, { state, bundle }),
    'worldImpacts.macroThreatsToAdd[0].id');
}
{
  // duplicate ids within batch
  const o = makeOutput();
  o.worldImpacts.macroThreatsToAdd = [
    { id: 't1', displayName: 'A', duration: 24, phases: [{ atProgress: 0, label: 'p' }], onComplete: { majorEvent: 'x' } },
    { id: 't1', displayName: 'B', duration: 24, phases: [{ atProgress: 0, label: 'p' }], onComplete: { majorEvent: 'x' } }
  ];
  assertFailAt('duplicate macro-threat ids within batch rejected',
    validateModelOutput(o, { state, bundle }),
    'worldImpacts.macroThreatsToAdd[1].id');
}
{
  // per-game cap: 1 existing model-authored + 2 new = 3 > cap (2) -- reject
  const stateWithModelThreat = makeState();
  stateWithModelThreat.threats['model-threat-existing'] = {
    progress: 10, currentPhase: 'p', slowedBy: 0,
    knownToPlayer: false, revealedAtHour: null,
    completed: false, completedAt: null, authorSource: 'model'
  };
  const o = makeOutput();
  o.worldImpacts.macroThreatsToAdd = [
    { id: 'new1', displayName: 'A', duration: 24, phases: [{ atProgress: 0, label: 'p' }], onComplete: { majorEvent: 'x' } },
    { id: 'new2', displayName: 'B', duration: 24, phases: [{ atProgress: 0, label: 'p' }], onComplete: { majorEvent: 'x' } }
  ];
  assertFailAt(`per-game cap exceeded (1+2 > ${MODEL_AUTHORED_THREAT_CAP}) rejected`,
    validateModelOutput(o, { state: stateWithModelThreat, bundle }),
    'worldImpacts.macroThreatsToAdd');
}
{
  // 0 existing + 2 new = 2 <= cap -- accept
  const o = makeOutput();
  o.worldImpacts.macroThreatsToAdd = [
    { id: 'new1', displayName: 'A', duration: 24, phases: [{ atProgress: 0, label: 'p' }], onComplete: { majorEvent: 'x' } },
    { id: 'new2', displayName: 'B', duration: 24, phases: [{ atProgress: 0, label: 'p' }], onComplete: { majorEvent: 'x' } }
  ];
  assertPass(`0 existing + 2 new accepted (cap=${MODEL_AUTHORED_THREAT_CAP})`,
    validateModelOutput(o, { state, bundle }));
}
{
  // 3 in a single batch -- ajv schema rejects (maxItems: 2) before semantic check
  const o = makeOutput();
  o.worldImpacts.macroThreatsToAdd = [
    { id: 'new1', displayName: 'A', duration: 24, phases: [{ atProgress: 0, label: 'p' }], onComplete: { majorEvent: 'x' } },
    { id: 'new2', displayName: 'B', duration: 24, phases: [{ atProgress: 0, label: 'p' }], onComplete: { majorEvent: 'x' } },
    { id: 'new3', displayName: 'C', duration: 24, phases: [{ atProgress: 0, label: 'p' }], onComplete: { majorEvent: 'x' } }
  ];
  assertFailAt('3 macro-threats in batch rejected (schema maxItems)',
    validateModelOutput(o, { state, bundle }),
    'worldImpacts.macroThreatsToAdd');
}

// ---------- per-world enums ----------

console.log('\n--- per-world enums ---');

{
  const o = makeOutput();
  o.worldImpacts.stateChanges.worldStateDeltas = { kingStatus: 'dying' };
  assertPass('kingStatus=dying accepted',
    validateModelOutput(o, { state, bundle }));
}
{
  const o = makeOutput();
  o.worldImpacts.stateChanges.worldStateDeltas = { kingStatus: 'unicorn' };
  assertFailAt('kingStatus=unicorn rejected',
    validateModelOutput(o, { state, bundle }),
    'worldImpacts.stateChanges.worldStateDeltas.kingStatus');
}
{
  const o = makeOutput();
  o.worldImpacts.stateChanges.worldStateDeltas = { antagonistPower: 'king' };
  assertPass('antagonistPower=king accepted',
    validateModelOutput(o, { state, bundle }));
}

// ---------- npc references ----------

console.log('\n--- npc references ---');

{
  const o = makeOutput();
  o.npcImpacts = [{ npcId: 'sera', statusDelta: 'wary' }];
  assertPass('npcId=sera accepted',
    validateModelOutput(o, { state, bundle }));
}
{
  const o = makeOutput();
  o.npcImpacts = [{ npcId: 'background-merchant-foo', statusDelta: 'wary' }];
  assertFailAt('npcId not in bundle rejected',
    validateModelOutput(o, { state, bundle }),
    'npcImpacts[0].npcId');
}

// ---------- unlocksThreats refs ----------

console.log('\n--- unlocksThreats references ---');

{
  const o = makeOutput();
  o.narrativeResponse.resolutionLinkContents.l1 = {
    content: 'A column of dust on the eastern road. Riders.',
    unlocksThreats: ['halric-coronation']    // exists in bundle
  };
  assertPass('unlocksThreats ref to bundle threat accepted',
    validateModelOutput(o, { state, bundle }));
}
{
  const o = makeOutput();
  o.narrativeResponse.resolutionLinkContents.l1 = {
    content: 'A column of dust on the eastern road. Riders.',
    unlocksThreats: ['nonexistent-threat']
  };
  assertFailAt('unlocksThreats ref to nonexistent rejected',
    validateModelOutput(o, { state, bundle }),
    'narrativeResponse.resolutionLinkContents.l1.unlocksThreats[0]');
}
{
  // unlocksThreats can reference a threat being added in the same turn
  const o = makeOutput();
  o.worldImpacts.macroThreatsToAdd = [
    { id: 'newly-discovered', displayName: 'X', duration: 36,
      phases: [{ atProgress: 0, label: 'p' }],
      onComplete: { majorEvent: 'x' } }
  ];
  o.narrativeResponse.resolutionLinkContents.l1 = {
    content: 'A column of dust on the eastern road. Riders.',
    unlocksThreats: ['newly-discovered']
  };
  assertPass('unlocksThreats ref to newly-added threat accepted',
    validateModelOutput(o, { state, bundle }));
}

// ---------- re-prompt template ----------

console.log('\n--- re-prompt template ---');

{
  const msg = RE_PROMPT_TEMPLATE('worldImpacts.stateChanges.clockHoursDelta', 'must be >= 0');
  ok('re-prompt mentions path',     msg.includes('worldImpacts.stateChanges.clockHoursDelta'));
  ok('re-prompt mentions message',  msg.includes('must be >= 0'));
  ok('re-prompt warns no extra text', msg.includes('Do not include any text outside the JSON object'));
}

{
  const o = makeOutput();
  o.worldImpacts.stateChanges.clockHoursDelta = -3;
  const result = validateModelOutput(o, { state, bundle });
  const first = firstError(result.errors);
  ok('firstError returns {path, message}',
     first && typeof first.path === 'string' && typeof first.message === 'string');
}

// ---------- summary ----------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
