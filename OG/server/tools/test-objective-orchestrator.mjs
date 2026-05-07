// Phase I test suite for the per-turn orchestrator.
// Run: node server/tools/test-objective-orchestrator.mjs
//
// Uses a mock model client (no real Claude calls) to drive the per-turn
// flow end-to-end. Verifies init, basic turn, validation re-prompt, each
// terminal type, investigation, and runHistory bookkeeping.

import {
  initGame,
  submitChoice,
  openLink
} from '../lib/objective-orchestrator.mjs';
import { loadWorldBundle } from '../lib/world-bundle.mjs';
import { DEFAULT_WORLD } from '../lib/config.mjs';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}${detail ? '\n  ' + detail : ''}`); fail++; }
}

const bundle = loadWorldBundle(DEFAULT_WORLD);

// ============================================================
// helpers: a mock model client and an output factory
// ============================================================

function mockClient(outputs) {
  // outputs is an array; each call returns the next one. Throws if exhausted.
  let i = 0;
  return {
    calls: [],
    async call({ system, user }) {
      this.calls.push({ system, user });
      if (i >= outputs.length) throw new Error(`mock client exhausted at call #${i}`);
      const out = outputs[i++];
      // Allow callable outputs that synthesize from the input
      return typeof out === 'function' ? out({ system, user }) : out;
    }
  };
}

function makeOutput({
  clockHoursDelta = 6,
  distanceDelta  = -5,
  isEnding = false,
  terminalState = null,
  nextBeat = null,
  resolutionProse = { segments: [{ type: 'text', content: 'You ride east.' }] },
  resolutionLinkContents = {},
  npcImpacts = [],
  threatSlowdowns = [],
  scheduledEventsToAdd = [],
  macroThreatsToAdd = [],
  worldStateDeltas = {},
  majorEventLogged = 'You moved east.',
  forwardProjection = { tonalAim: 'rising', currentConfidence: 'moderate' },
  directorReasoning = 'continuing east'
} = {}) {
  const beat = nextBeat ?? (isEnding ? null : {
    title: 'Test next beat',
    intro: { segments: [{ type: 'text', content: 'The road bends.' }] },
    introLinkContents: {},
    choices: [
      { label: 'A', text: 'Press on.',    risk: 'controlled' },
      { label: 'B', text: 'Make camp.',   risk: 'risky' }
    ]
  });
  return {
    worldImpacts: {
      stateChanges: {
        clockHoursDelta, distanceDelta,
        worldStateDeltas
      },
      majorEventLogged,
      threatSlowdowns,
      scheduledEventsToAdd,
      macroThreatsToAdd
    },
    npcImpacts,
    narrativeResponse: {
      resolutionProse, resolutionLinkContents,
      isEnding,
      terminalState,
      nextBeat: beat
    },
    forwardProjection,
    directorReasoning
  };
}

function openingChoices(state) {
  return bundle.openingScene.choices;
}

// ============================================================
// initGame
// ============================================================

console.log('--- initGame ---');
{
  const { state, response } = initGame({ gameId: 'g1', bundle });
  ok('state has gameId',                 state.gameId === 'g1');
  ok('state has worldName',              state.worldName === 'ember-crown');
  ok('clockHours = 96 from bundle',      state.clockHours === 96);
  ok('distanceToKing = 100 from bundle', state.distanceToKing === 100);
  ok('halric-coronation seeded',         Boolean(state.threats['halric-coronation']));
  ok('threats start unknown',            state.threats['halric-coronation'].knownToPlayer === false);
  ok('6 scheduled events seeded',        state.scheduledEvents.length === 6);
  ok('all events start pending',         state.scheduledEvents.every(e => e.status === 'pending'));
  ok('startingFacts seeded into investigatedFacts',
     state.playerKnowledge.investigatedFacts.includes('you have dreamed of fire and a burning crown for weeks'));

  ok('response is opening',              response.isOpening === true);
  ok('response not ending',              response.isEnding === false);
  ok('response has prose segments',      response.prose.segments.length > 0);
  ok('response has 3 choices',           response.choices.length === 3);
  ok('response has linkContents from openingScene',
     Object.keys(response.linkContents).length === 4);
}

// ============================================================
// submitChoice: basic turn
// ============================================================

console.log('\n--- submitChoice: basic turn ---');
{
  const { state } = initGame({ gameId: 'g2', bundle });
  const client = mockClient([makeOutput({ clockHoursDelta: 6, distanceDelta: -5 })]);
  const r = await submitChoice(state, bundle, {
    choiceLabel: 'A',
    choicesPresented: openingChoices(state),
    modelClient: client
  });
  ok('not failed',                  r.response !== null);
  ok('not retried (1st call ok)',   r.retried === false);
  ok('clockHours decremented to 90',state.clockHours === 90);
  ok('distanceToKing -> 95',        state.distanceToKing === 95);
  ok('lastChoiceRisk recorded',     state.lastChoiceRisk === 'controlled');
  ok('turnNumber incremented',      state.turnNumber === 2);
  ok('threat progress advanced',
     state.threats['halric-coronation'].progress === 6);
  ok('majorEventLogged appended',
     state.worldState.majorEvents.includes('You moved east.'));
  ok('response carries resolutionProse',
     r.response.resolutionProse.segments.length > 0);
  ok('response carries nextBeat',   Boolean(r.response.nextBeat));
}

// ============================================================
// submitChoice: rejects unknown choice label
// ============================================================

console.log('\n--- submitChoice: unknown choice label ---');
{
  const { state } = initGame({ gameId: 'g-bad', bundle });
  const client = mockClient([]);
  const r = await submitChoice(state, bundle, {
    choiceLabel: 'Z',
    choicesPresented: openingChoices(state),
    modelClient: client
  });
  ok('rejects unknown label',  r.response === null);
  ok('error logged',           r.log.kind === 'error');
  ok('no model call made',     client.calls.length === 0);
}

// ============================================================
// submitChoice: validation failure -> one re-prompt
// ============================================================

console.log('\n--- submitChoice: validation re-prompt ---');
{
  const { state } = initGame({ gameId: 'g-retry', bundle });
  // First call: invalid (1 choice instead of 2-4). Second call: valid.
  const badOutput = makeOutput();
  badOutput.narrativeResponse.nextBeat.choices = [{ label: 'A', text: 'only one', risk: 'controlled' }];
  const client = mockClient([badOutput, makeOutput()]);
  const r = await submitChoice(state, bundle, {
    choiceLabel: 'A',
    choicesPresented: openingChoices(state),
    modelClient: client
  });
  ok('orchestrator retried',     r.retried === true);
  ok('two model calls made',     client.calls.length === 2);
  ok('second call includes re-prompt instruction',
     client.calls[1].user.includes('failed validation'));
  ok('final response succeeded', r.response !== null);
}

console.log('\n--- submitChoice: validation failure twice -> error ---');
{
  const { state } = initGame({ gameId: 'g-fail', bundle });
  const badOutput = makeOutput();
  badOutput.narrativeResponse.nextBeat.choices = [];
  const client = mockClient([badOutput, badOutput]);
  const r = await submitChoice(state, bundle, {
    choiceLabel: 'A',
    choicesPresented: openingChoices(state),
    modelClient: client
  });
  ok('returns null response',          r.response === null);
  ok('log.kind = validation-failed',   r.log.kind === 'validation-failed');
  ok('errors carried',                 Array.isArray(r.log.errors) && r.log.errors.length > 0);
}

// ============================================================
// terminal: reached-king
// ============================================================

console.log('\n--- terminal: reached-king ---');
{
  const { state } = initGame({ gameId: 'g-king', bundle });
  // Push distance close to 5 first via a couple of normal turns.
  // Easier: jam state.distanceToKing to 6 and make the next turn end with -2.
  state.distanceToKing = 6;
  const client = mockClient([makeOutput({
    clockHoursDelta: 4,
    distanceDelta: -2,    // 6 + (-2) = 4 <= 5 -> reached-king legal
    isEnding: true,
    terminalState: { kind: 'reached-king', summary: 'You stand at his bedside.' },
    nextBeat: null
  })]);
  const r = await submitChoice(state, bundle, {
    choiceLabel: 'A',
    choicesPresented: openingChoices(state),
    modelClient: client
  });
  ok('response.isEnding = true',         r.response.isEnding === true);
  ok('terminalState kind = reached-king',
     r.response.terminalState?.kind === 'reached-king');
  ok('state.terminalState set',          state.terminalState?.kind === 'reached-king');
  ok('state.distanceToKing == 4',        state.distanceToKing === 4);
}

// ============================================================
// terminal: killed (with desperate)
// ============================================================

console.log('\n--- terminal: killed requires desperate ---');
{
  const { state } = initGame({ gameId: 'g-killed', bundle });
  // Replace opening choices with a desperate option so the lethality gate trips correctly.
  const choicesPresented = [
    { label: 'A', text: 'Stride into the camp.',     risk: 'desperate' },
    { label: 'B', text: 'Hold position in the dark.', risk: 'controlled' }
  ];
  const client = mockClient([makeOutput({
    clockHoursDelta: 1,
    distanceDelta: 0,
    isEnding: true,
    terminalState: { kind: 'killed', summary: 'A blade in the dark.' },
    nextBeat: null
  })]);
  const r = await submitChoice(state, bundle, {
    choiceLabel: 'A',
    choicesPresented,
    modelClient: client
  });
  ok('killed terminal accepted on desperate',
     r.response?.terminalState?.kind === 'killed');
  ok('state.lastChoiceRisk = desperate',
     state.lastChoiceRisk === 'desperate');
}

console.log('\n--- terminal: killed REJECTED on controlled (lethality gate) ---');
{
  const { state } = initGame({ gameId: 'g-killed-fail', bundle });
  const choicesPresented = [{ label: 'A', text: 'Walk in.', risk: 'controlled' }, { label: 'B', text: 'Wait.', risk: 'risky' }];
  const badOutput = makeOutput({
    clockHoursDelta: 1,
    isEnding: true,
    terminalState: { kind: 'killed', summary: 'A blade in the dark.' },
    nextBeat: null
  });
  // Both calls return the same bad output -> two retries fail
  const client = mockClient([badOutput, badOutput]);
  const r = await submitChoice(state, bundle, {
    choiceLabel: 'A',
    choicesPresented,
    modelClient: client
  });
  ok('orchestrator rejects illegal lethality',
     r.response === null && r.log.kind === 'validation-failed');
  ok('retry attempted',
     client.calls.length === 2);
}

// ============================================================
// terminal: forced time-up (clockHours <= 0 from previous turn)
// ============================================================

console.log('\n--- terminal: forced time-up on next turn ---');
{
  const { state } = initGame({ gameId: 'g-forced', bundle });
  // Simulate previous turn pushed clockHours to 0.
  state.clockHours = 0;
  const client = mockClient([]);  // no model call expected
  const r = await submitChoice(state, bundle, {
    choiceLabel: 'A',
    choicesPresented: openingChoices(state),
    modelClient: client
  });
  ok('forced terminal returned',     r.response.isEnding === true);
  ok('terminalState.kind = time-up', r.response.terminalState?.kind === 'time-up');
  ok('forced flag set',              r.response.forced === true);
  ok('no model call made',           client.calls.length === 0);
  ok('state.terminalState set',      state.terminalState?.kind === 'time-up');
}

// ============================================================
// scheduled events fire during turn
// ============================================================

console.log('\n--- scheduled events fire during turn ---');
{
  const { state } = initGame({ gameId: 'g-events', bundle });
  // Big tick -> hour 24, comet-near-zenith-24h fires (24 is the max per validator)
  const client = mockClient([makeOutput({ clockHoursDelta: 24, distanceDelta: -10 })]);
  await submitChoice(state, bundle, {
    choiceLabel: 'A',
    choicesPresented: openingChoices(state),
    modelClient: client
  });
  ok('comet event fired',
     state.scheduledEvents.find(e => e.id === 'comet-near-zenith-24h').status === 'fired');
  ok('worldStateDelta from event applied (cometStage)',
     state.worldState.cometStage === 'near-zenith');
  ok('event revelation surfaced (delay=0)',
     state.playerKnowledge.witnessedEvents.some(e => e.eventId === 'comet-near-zenith-24h'));
  ok('runHistory.counterfactualsFiredKnown updated',
     state.runHistory.counterfactualsFiredKnown.includes('comet-near-zenith-24h'));
}

// ============================================================
// threat slowdowns from model output
// ============================================================

console.log('\n--- threat slowdowns from model output ---');
{
  const { state } = initGame({ gameId: 'g-slow', bundle });
  // Reveal halric so the slowdown matters
  state.threats['halric-coronation'].knownToPlayer = true;
  state.playerKnowledge.knownThreatIds.push('halric-coronation');

  const client = mockClient([makeOutput({
    clockHoursDelta: 8,
    threatSlowdowns: [{ threatId: 'halric-coronation', hours: 6, reason: 'messenger intercepted' }]
  })]);
  await submitChoice(state, bundle, {
    choiceLabel: 'A',
    choicesPresented: openingChoices(state),
    modelClient: client
  });
  ok('slowedBy applied (6)',
     state.threats['halric-coronation'].slowedBy === 6);
  ok('progress still advanced by full clockHoursDelta (8)',
     state.threats['halric-coronation'].progress === 8);
}

// ============================================================
// model-authored scheduled event
// ============================================================

console.log('\n--- model-authored scheduledEventsToAdd ---');
{
  const { state } = initGame({ gameId: 'g-sched-add', bundle });
  const client = mockClient([makeOutput({
    clockHoursDelta: 3,
    scheduledEventsToAdd: [{
      id: 'rider-pursues-50h', fireAtHour: 50, preconditions: [],
      outcomeOnFire: { revelation: { strength: 'quiet', delayHours: 12, content: 'A lone rider.' } }
    }]
  })]);
  await submitChoice(state, bundle, {
    choiceLabel: 'A',
    choicesPresented: openingChoices(state),
    modelClient: client
  });
  const added = state.scheduledEvents.find(e => e.id === 'rider-pursues-50h');
  ok('model event appended to scheduledEvents', Boolean(added));
  ok('model event tagged authorSource=model',  added.authorSource === 'model');
}

// ============================================================
// openLink (investigation)
// ============================================================

console.log('\n--- openLink: investigation flow ---');
{
  const { state, response } = initGame({ gameId: 'g-link', bundle });
  const r = openLink(state, bundle, {
    beatNumber: 1,
    linkId: 'ow-pin',                    // unlocksFacts: rider-wears-old-faction-pin
    linkContents: response.linkContents
  });
  ok('investigation ok',  r.result.ok === true);
  ok('fact added to investigatedFacts',
     state.playerKnowledge.investigatedFacts.includes('rider-wears-old-faction-pin'));
}

// ============================================================
// runHistory: threat completion -> threatsCompleted
// ============================================================

console.log('\n--- runHistory: threat completion bookkeeping ---');
{
  const { state } = initGame({ gameId: 'g-history', bundle });
  // Burn 96 hours in a single turn -> halric-coronation completes
  // (also triggers forced-end since onComplete sets antagonistPower=king)
  // Need a model output that is consistent with the cap, then engine ticks
  // halric to completion via clockHoursDelta=24 multiple times. Easier:
  // jam state.threats progress to 90 first.
  state.threats['halric-coronation'].progress = 90;

  const client = mockClient([makeOutput({ clockHoursDelta: 10, distanceDelta: -2 })]);
  await submitChoice(state, bundle, {
    choiceLabel: 'A',
    choicesPresented: openingChoices(state),
    modelClient: client
  });
  ok('halric completed',
     state.threats['halric-coronation'].completed === true);
  ok('runHistory.threatsCompleted has halric',
     state.runHistory.threatsCompleted.includes('halric-coronation'));
  ok('halric onComplete worldStateDelta applied (antagonistPower=king)',
     state.worldState.antagonistPower === 'king');
}

// ---------- summary ----------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
