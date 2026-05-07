// Phase E test suite for the scheduled-events engine.
// Run: node server/tools/test-scheduled-events.mjs

import {
  evaluatePrecondition,
  shouldCancel,
  seedScheduledEventsFromBundle,
  addModelScheduledEvent,
  fireDueEvents,
  applyEventOutcome,
  enqueueRevelation,
  surfaceDueRevelations,
  tickScheduledEvents
} from '../lib/scheduled-events-engine.mjs';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}${detail ? '\n  ' + detail : ''}`); fail++; }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---------- fixtures ----------

function makeBundle() {
  return {
    startingClocks: { clockHours: 96 },
    characters: [
      { id: 'sera',                 name: 'Sera',   startingLocation: 'eastern road', startingStatus: 'alive' },
      { id: 'high-advisor-halric',  name: 'Halric', startingLocation: 'keep',         startingStatus: 'scheming' }
    ],
    authoredScheduledEvents: [
      {
        id: 'comet-near-zenith-24h',
        fireAtHour: 24,
        preconditions: [],
        outcomeOnFire: {
          worldStateDelta: { cometStage: 'near-zenith' },
          revelation: { strength: 'ambient', delayHours: 0, content: 'The comet hangs lower now.' }
        },
        outcomeOnCancel: null
      },
      {
        id: 'halric-searches-east-40h',
        fireAtHour: 40,
        preconditions: [],
        outcomeOnFire: {
          npcImpacts: [
            { npcId: 'high-advisor-halric', statusDelta: 'actively-searching',
              knowledgeGained: [{ fact: 'dreamer-east', confidence: 'suspected' }] }
          ],
          revelation: { strength: 'quiet', delayHours: 6, content: 'Travellers report stopped wagons.' }
        },
        outcomeOnCancel: null
      }
    ]
  };
}

function makeState() {
  return {
    gameId: 'test', worldName: 'ember-crown',
    turnNumber: 0, lastAppliedLogTurn: 0,
    clockHours: 96, distanceToKing: 100,
    condition: 'tired', location: "Wren's Hollow", assets: [],
    lastChoiceRisk: null,
    worldState: {
      timeOfDay: 'dawn', cometStage: 'approaching',
      kingStatus: 'declining', crownStatus: 'dormant', antagonistPower: 'advisor',
      majorEvents: []
    },
    threats: {},
    scheduledEvents: [],
    pendingRevelations: [],
    playerKnowledge: { knownThreatIds: [], witnessedEvents: [], rumors: [], investigatedFacts: [] },
    npcStates: {},
    runHistory: { threatsCompleted: [], threatsStopped: [], threatsNeverLearned: [], counterfactualsFiredKnown: [], counterfactualsFiredSilent: [] },
    terminalState: null
  };
}

const bundle = makeBundle();

// ---------- evaluatePrecondition ----------

console.log('--- evaluatePrecondition ---');
{
  const s = makeState();
  s.npcStates = { sera: { status: 'dead' }, halric: { status: 'scheming' } };
  s.assets = ['horse', 'wardstone'];
  s.playerKnowledge.investigatedFacts = ['halric-plotting'];
  s.threats = { 'halric-coronation': { completed: true } };
  s.worldState.cometStage = 'zenith';

  ok('npcDead true',     evaluatePrecondition({ check: 'npcDead',         npcId: 'sera'  }, s) === true);
  ok('npcDead false',    evaluatePrecondition({ check: 'npcDead',         npcId: 'halric'}, s) === false);
  ok('npcAlive true',    evaluatePrecondition({ check: 'npcAlive',        npcId: 'halric'}, s) === true);
  ok('npcAlive false (dead)', evaluatePrecondition({ check: 'npcAlive',   npcId: 'sera'  }, s) === false);
  ok('npcAlive false (missing)', evaluatePrecondition({ check: 'npcAlive', npcId: 'ghost'}, s) === false);
  ok('playerHasAsset true',     evaluatePrecondition({ check: 'playerHasAsset',   asset: 'horse'    }, s) === true);
  ok('playerHasAsset false',    evaluatePrecondition({ check: 'playerHasAsset',   asset: 'sword'    }, s) === false);
  ok('playerLacksAsset true',   evaluatePrecondition({ check: 'playerLacksAsset', asset: 'sword'    }, s) === true);
  ok('playerLacksAsset false',  evaluatePrecondition({ check: 'playerLacksAsset', asset: 'horse'    }, s) === false);
  ok('playerKnowsFact true',    evaluatePrecondition({ check: 'playerKnowsFact',  fact: 'halric-plotting' }, s) === true);
  ok('playerKnowsFact false',   evaluatePrecondition({ check: 'playerKnowsFact',  fact: 'unknown'   }, s) === false);
  ok('threatCompleted true',    evaluatePrecondition({ check: 'threatCompleted',  threatId: 'halric-coronation' }, s) === true);
  ok('threatCompleted false',   evaluatePrecondition({ check: 'threatCompleted',  threatId: 'plague' }, s) === false);
  ok('worldStateEquals true',   evaluatePrecondition({ check: 'worldStateEquals', key: 'cometStage', value: 'zenith' }, s) === true);
  ok('worldStateEquals false',  evaluatePrecondition({ check: 'worldStateEquals', key: 'cometStage', value: 'passing' }, s) === false);
  ok('always',                  evaluatePrecondition({ check: 'always' }, s) === true);
  ok('never',                   evaluatePrecondition({ check: 'never'  }, s) === false);

  let threw = false;
  try { evaluatePrecondition({ check: 'unknown-check' }, s); }
  catch (e) { threw = e.message.includes("Unknown precondition check"); }
  ok('unknown check throws', threw);

  threw = false;
  try { evaluatePrecondition({}, s); }
  catch (e) { threw = e.message.includes("missing 'check' field"); }
  ok('missing check field throws', threw);
}

// ---------- shouldCancel ----------

console.log('\n--- shouldCancel ---');
{
  const s = makeState();
  s.npcStates = { lead: { status: 'dead' }, ally: { status: 'alive' } };
  ok('empty preconditions -> false (event fires)',
     shouldCancel([], s) === false);
  ok('any-true -> cancel',
     shouldCancel([{ check: 'never' }, { check: 'npcDead', npcId: 'lead' }], s) === true);
  ok('all-false -> fire',
     shouldCancel([{ check: 'never' }, { check: 'npcAlive', npcId: 'lead' }], s) === false);
}

// ---------- seedScheduledEventsFromBundle ----------

console.log('\n--- seedScheduledEventsFromBundle ---');
{
  const s = makeState();
  seedScheduledEventsFromBundle(s, bundle);
  ok('seeded both bundle events', s.scheduledEvents.length === 2);
  ok('events start as pending',   s.scheduledEvents.every(e => e.status === 'pending'));
  ok('events tagged authored',    s.scheduledEvents.every(e => e.authorSource === 'authored'));

  // Idempotent: pre-existing event preserved
  s.scheduledEvents[0].status = 'fired';
  seedScheduledEventsFromBundle(s, bundle);
  ok('seed is idempotent (preserves existing status)',
     s.scheduledEvents.find(e => e.id === 'comet-near-zenith-24h').status === 'fired');
  ok('seed did not duplicate', s.scheduledEvents.length === 2);
}

// ---------- addModelScheduledEvent ----------

console.log('\n--- addModelScheduledEvent ---');
{
  const s = makeState();
  seedScheduledEventsFromBundle(s, bundle);
  addModelScheduledEvent(s, {
    id: 'rider-pursues-50h',
    fireAtHour: 50,
    preconditions: [],
    outcomeOnFire: { revelation: { strength: 'quiet', delayHours: 0, content: 'A lone rider follows.' } }
  });
  const added = s.scheduledEvents.find(e => e.id === 'rider-pursues-50h');
  ok('model event appended',  Boolean(added));
  ok('model event tagged "model"', added.authorSource === 'model');

  let threw = false;
  try { addModelScheduledEvent(s, { id: 'rider-pursues-50h', fireAtHour: 60 }); }
  catch (e) { threw = e.message.includes('id collision'); }
  ok('duplicate id throws', threw);
}

// ---------- fireDueEvents: basic ----------

console.log('\n--- fireDueEvents: basic ---');
{
  const s = makeState();
  seedScheduledEventsFromBundle(s, bundle);

  // currentHour = 23: nothing fires yet
  let r = fireDueEvents(s, { currentHour: 23 });
  ok('nothing fires before fireAtHour', r.fired.length === 0 && r.cancelled.length === 0);

  // currentHour = 24: comet-near-zenith fires
  r = fireDueEvents(s, { currentHour: 24 });
  ok('comet-near-zenith fires at 24h',
     r.fired.length === 1 && r.fired[0].eventId === 'comet-near-zenith-24h');
  ok('event status -> fired',
     s.scheduledEvents.find(e => e.id === 'comet-near-zenith-24h').status === 'fired');

  // currentHour = 24 again: no double-fire
  r = fireDueEvents(s, { currentHour: 24 });
  ok('event does not fire twice', r.fired.length === 0);

  // currentHour = 100: catches any remaining (halric-searches-40h)
  r = fireDueEvents(s, { currentHour: 100 });
  ok('remaining event fires at 100h', r.fired.length === 1);
}

// ---------- fireDueEvents: preconditions cause cancellation ----------

console.log('\n--- fireDueEvents: precondition cancellation ---');
{
  const s = makeState();
  s.scheduledEvents.push({
    id: 'ally-ambush-day3',
    fireAtHour: 60,
    preconditions: [
      { check: 'npcDead', npcId: 'patrol-lead' }   // if true, ambush cancels
    ],
    outcomeOnFire: {
      npcImpacts: [{ npcId: 'sera', statusDelta: 'wounded' }],
      revelation: { strength: 'loud', delayHours: 0, content: 'A patrol overtakes Sera.' }
    },
    outcomeOnCancel: {
      revelation: { strength: 'quiet', delayHours: 12, content: 'Sera arrives shaken but alive.' }
    },
    status: 'pending', authorSource: 'authored'
  });

  // patrol-lead dead -> precondition true -> CANCEL
  s.npcStates['patrol-lead'] = { status: 'dead' };
  const r = fireDueEvents(s, { currentHour: 60 });
  ok('event cancelled when precondition true',
     r.cancelled.length === 1 && r.cancelled[0].eventId === 'ally-ambush-day3');
  ok('event not in fired list',  r.fired.length === 0);
  ok('event status -> cancelled',
     s.scheduledEvents[0].status === 'cancelled');
  ok('cancel outcome carries the cancel revelation',
     r.cancelled[0].outcome.revelation.strength === 'quiet');
}

console.log('\n--- fireDueEvents: precondition false -> fires ---');
{
  const s = makeState();
  s.scheduledEvents.push({
    id: 'ally-ambush-day3',
    fireAtHour: 60,
    preconditions: [{ check: 'npcDead', npcId: 'patrol-lead' }],
    outcomeOnFire: { npcImpacts: [], revelation: { strength: 'loud', delayHours: 0, content: 'patrol arrives' } },
    outcomeOnCancel: null,
    status: 'pending', authorSource: 'authored'
  });
  // patrol-lead alive -> precondition false -> FIRE
  s.npcStates['patrol-lead'] = { status: 'alive' };
  const r = fireDueEvents(s, { currentHour: 60 });
  ok('event fires when no precondition is true', r.fired.length === 1);
  ok('cancellation list empty',                  r.cancelled.length === 0);
}

// ---------- applyEventOutcome ----------

console.log('\n--- applyEventOutcome ---');
{
  const s = makeState();
  const outcome = {
    worldStateDelta: { cometStage: 'zenith', kingStatus: 'dying' },
    npcImpacts: [
      { npcId: 'sera', statusDelta: 'wounded',
        knowledgeGained: [{ fact: 'patrol-attacked-us', confidence: 'certain' }] }
    ]
  };
  applyEventOutcome(s, outcome, bundle, 'event:test');
  ok('worldStateDelta applied (cometStage)', s.worldState.cometStage === 'zenith');
  ok('worldStateDelta applied (kingStatus)', s.worldState.kingStatus === 'dying');
  ok('npc state created from bundle defaults',
     s.npcStates.sera.location === 'eastern road');
  ok('npc statusDelta applied',          s.npcStates.sera.status === 'wounded');
  ok('knowledge appended with source tag',
     s.npcStates.sera.currentKnowledge[0].source === 'event:test');
  ok('knowledge fact preserved',
     s.npcStates.sera.currentKnowledge[0].fact === 'patrol-attacked-us');
}

console.log('\n--- applyEventOutcome: existing npc not overwritten by defaults ---');
{
  const s = makeState();
  s.npcStates.sera = { location: 'custom-here', status: 'wary', motivationDelta: null, currentKnowledge: [] };
  applyEventOutcome(s, { npcImpacts: [{ npcId: 'sera', motivationDelta: 'doubting' }] }, bundle, 'src');
  ok('existing location preserved (no defaults applied)',
     s.npcStates.sera.location === 'custom-here');
  ok('motivationDelta applied',
     s.npcStates.sera.motivationDelta === 'doubting');
}

console.log('\n--- applyEventOutcome: null outcome no-op ---');
{
  const s = makeState();
  const r = applyEventOutcome(s, null, bundle, 'src');
  ok('null outcome returns empty changes',
     r.worldStateChanges.length === 0 && r.npcChanges.length === 0);
}

// ---------- enqueueRevelation ----------

console.log('\n--- enqueueRevelation ---');
{
  const s = makeState();
  const e = enqueueRevelation(s, {
    eventId: 'evt-1', fireAtHour: 24,
    revelation: { strength: 'quiet', delayHours: 6, content: 'rider' }
  });
  ok('enqueued entry returned', e?.eventId === 'evt-1');
  ok('surfaceAtHour = fire + delay (24+6=30)', e.surfaceAtHour === 30);
  ok('queue length 1', s.pendingRevelations.length === 1);

  const silent = enqueueRevelation(s, {
    eventId: 'evt-2', fireAtHour: 24,
    revelation: { strength: 'silent', delayHours: 0, content: 'invisible' }
  });
  ok('silent revelation NOT enqueued', silent === null);
  ok('queue length still 1',           s.pendingRevelations.length === 1);

  const noRev = enqueueRevelation(s, { eventId: 'evt-3', fireAtHour: 24, revelation: null });
  ok('null revelation NOT enqueued',   noRev === null);
}

// ---------- surfaceDueRevelations ----------

console.log('\n--- surfaceDueRevelations ---');
{
  const s = makeState();
  s.pendingRevelations = [
    { eventId: 'a', surfaceAtHour: 10, strength: 'loud',    content: 'now-due' },
    { eventId: 'b', surfaceAtHour: 50, strength: 'quiet',   content: 'later'   },
    { eventId: 'c', surfaceAtHour: 5,  strength: 'ambient', content: 'past-due' }
  ];

  const surfaced = surfaceDueRevelations(s, { currentHour: 12 });
  ok('two revelations surfaced (a, c)',
     surfaced.length === 2 && surfaced.map(r => r.eventId).sort().join(',') === 'a,c');
  ok('queue retains the future one (b)',
     s.pendingRevelations.length === 1 && s.pendingRevelations[0].eventId === 'b');
  ok('witnessedEvents has 2 entries',
     s.playerKnowledge.witnessedEvents.length === 2);
  ok('witnessedEvents.atHour stamped at currentHour',
     s.playerKnowledge.witnessedEvents.every(w => w.atHour === 12));
  ok('witnessedEvents.summary preserves content',
     s.playerKnowledge.witnessedEvents.find(w => w.eventId === 'a').summary === 'now-due');
}

// ---------- tickScheduledEvents (full orchestration) ----------

console.log('\n--- tickScheduledEvents: full orchestration ---');
{
  const s = makeState();
  seedScheduledEventsFromBundle(s, bundle);

  // hour 24: comet event fires + immediately surfaces (delay 0)
  const r = tickScheduledEvents(s, bundle, { currentHour: 24 });
  ok('comet event fired',           r.fired.some(f => f.eventId === 'comet-near-zenith-24h'));
  ok('worldState mutated by tick',  s.worldState.cometStage === 'near-zenith');
  ok('revelation enqueued',         r.enqueued.length === 1);
  ok('revelation surfaced same turn (delay=0)',
     r.surfaced.some(x => x.eventId === 'comet-near-zenith-24h'));
  ok('queue empty after surface',   s.pendingRevelations.length === 0);
  ok('witnessedEvents has comet',
     s.playerKnowledge.witnessedEvents.some(w => w.eventId === 'comet-near-zenith-24h'));
}

console.log('\n--- tickScheduledEvents: delayed revelation surfaces later ---');
{
  const s = makeState();
  seedScheduledEventsFromBundle(s, bundle);

  // hour 40: halric-searches fires; revelation has delay 6 -> surfaces at hour 46
  let r = tickScheduledEvents(s, bundle, { currentHour: 40 });
  ok('halric-searches fired at 40',
     r.fired.some(f => f.eventId === 'halric-searches-east-40h'));
  ok('npc impact applied (status)',
     s.npcStates['high-advisor-halric'].status === 'actively-searching');
  ok('npc impact applied (knowledge)',
     s.npcStates['high-advisor-halric'].currentKnowledge.some(k => k.fact === 'dreamer-east'));
  // halric revelation has delay 6, so surfaceAtHour = 46. The comet event
  // (fireAtHour 24, delay 0) also fired in this wide tick and surfaced
  // immediately, so we check the halric one specifically.
  const halricInQueue = (st) => st.pendingRevelations.some(x => x.eventId === 'halric-searches-east-40h');
  ok('halric revelation queued, not yet surfaced',
     halricInQueue(s) && !r.surfaced.some(x => x.eventId === 'halric-searches-east-40h'));

  // hour 45: still queued
  r = tickScheduledEvents(s, bundle, { currentHour: 45 });
  ok('halric still pending at hour 45',
     halricInQueue(s) && !r.surfaced.some(x => x.eventId === 'halric-searches-east-40h'));

  // hour 46: surfaces
  r = tickScheduledEvents(s, bundle, { currentHour: 46 });
  ok('halric surfaces at hour 46',
     r.surfaced.some(x => x.eventId === 'halric-searches-east-40h') && !halricInQueue(s));
}

console.log('\n--- tickScheduledEvents: cancellation queues only the cancel revelation ---');
{
  const s = makeState();
  s.npcStates['patrol-lead'] = { status: 'dead' };  // cancellation precondition true
  s.scheduledEvents.push({
    id: 'ally-ambush-day3',
    fireAtHour: 60,
    preconditions: [{ check: 'npcDead', npcId: 'patrol-lead' }],
    outcomeOnFire: {
      worldStateDelta: { kingStatus: 'dying' },   // would have applied if fired
      revelation: { strength: 'loud', delayHours: 0, content: 'fired path' }
    },
    outcomeOnCancel: {
      revelation: { strength: 'quiet', delayHours: 12, content: 'cancel path' }
    },
    status: 'pending', authorSource: 'authored'
  });

  const r = tickScheduledEvents(s, bundle, { currentHour: 60 });
  ok('event cancelled', r.cancelled.length === 1);
  ok('cancel revelation enqueued (delayed by 12 -> hour 72)',
     s.pendingRevelations.length === 1 && s.pendingRevelations[0].surfaceAtHour === 72);
  ok('worldStateDelta from outcomeOnFire NOT applied',
     s.worldState.kingStatus !== 'dying');
}

console.log('\n--- tickScheduledEvents: silent cancel produces no queue entry ---');
{
  const s = makeState();
  s.npcStates['patrol-lead'] = { status: 'dead' };
  s.scheduledEvents.push({
    id: 'ally-ambush-silent',
    fireAtHour: 60,
    preconditions: [{ check: 'npcDead', npcId: 'patrol-lead' }],
    outcomeOnFire: { revelation: { strength: 'loud', delayHours: 0, content: 'fired' } },
    outcomeOnCancel: { revelation: { strength: 'silent', delayHours: 0, content: 'never told' } },
    status: 'pending', authorSource: 'authored'
  });

  const r = tickScheduledEvents(s, bundle, { currentHour: 60 });
  ok('event cancelled', r.cancelled.length === 1);
  ok('silent revelation NOT enqueued', s.pendingRevelations.length === 0);
  ok('no enqueued entry returned',     r.enqueued.length === 0);
}

console.log('\n--- tickScheduledEvents: multiple events fire on a wide tick ---');
{
  const s = makeState();
  seedScheduledEventsFromBundle(s, bundle);
  // Jump straight to hour 100 — both bundle events should fire
  const r = tickScheduledEvents(s, bundle, { currentHour: 100 });
  ok('both bundle events fired in one wide tick', r.fired.length === 2);
  ok('all event statuses now resolved',
     s.scheduledEvents.every(e => e.status !== 'pending'));
}

// ---------- summary ----------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
