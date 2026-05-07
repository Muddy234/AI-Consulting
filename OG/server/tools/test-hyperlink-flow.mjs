// Phase H test suite for hyperlink investigation flow.
// Run: node server/tools/test-hyperlink-flow.mjs

import {
  applyInvestigation,
  isLinkOpened
} from '../lib/investigation.mjs';
import { seedThreatsFromBundle } from '../lib/threat-engine.mjs';
import { seedScheduledEventsFromBundle } from '../lib/scheduled-events-engine.mjs';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}${detail ? '\n  ' + detail : ''}`); fail++; }
}

// ---------- fixtures ----------

function makeBundle() {
  return {
    startingClocks: { clockHours: 96 },
    characters: [
      { id: 'sera',   name: 'Sera',   startingLocation: "Wren's Hollow", startingStatus: 'wary' },
      { id: 'halric', name: 'Halric', startingLocation: 'keep',         startingStatus: 'scheming' }
    ],
    threats: [
      {
        id: 'halric-coronation',
        displayName: "Halric's Plan",
        duration: 96,
        phases: [
          { atProgress: 0,  label: 'Brewing'  },
          { atProgress: 40, label: 'Moving'   }
        ],
        onComplete: { worldStateDelta: { antagonistPower: 'king' }, majorEvent: 'crowned' }
      }
    ],
    authoredScheduledEvents: [
      {
        id: 'comet-near-zenith-24h',
        fireAtHour: 24,
        preconditions: [],
        outcomeOnFire: {
          worldStateDelta: { cometStage: 'near-zenith' },
          revelation: { strength: 'ambient', delayHours: 0, content: 'comet hangs lower' }
        },
        outcomeOnCancel: null
      }
    ]
  };
}

function makeState() {
  return {
    gameId: 'test', worldName: 'ember-crown',
    turnNumber: 2, lastAppliedLogTurn: 2,
    clockHours: 90, distanceToKing: 95,
    condition: 'tired', location: "Wren's Hollow", assets: [],
    lastChoiceRisk: 'controlled',
    worldState: {
      timeOfDay: 'dawn', cometStage: 'approaching',
      kingStatus: 'declining', crownStatus: 'dormant', antagonistPower: 'advisor',
      majorEvents: []
    },
    threats: {},
    scheduledEvents: [],
    pendingRevelations: [],
    openedLinks: {},
    playerKnowledge: { knownThreatIds: [], witnessedEvents: [], rumors: [], investigatedFacts: [] },
    npcStates: {},
    runHistory: { threatsCompleted: [], threatsStopped: [], threatsNeverLearned: [], counterfactualsFiredKnown: [], counterfactualsFiredSilent: [] },
    terminalState: null
  };
}

const bundle = makeBundle();

const linkContents = {
  'ow-village': {
    content: 'Your village. Quiet. Four days west of Vael\'s Reach.'
    // no costHours, no unlocks
  },
  'ow-pin': {
    content: 'The mark of the Old Faction.',
    unlocksFacts: ['rider-wears-old-faction-pin']
  },
  'sera-bible': {
    content: 'A messenger of the Old Faction.',
    costHours: 1
  },
  'investigate-keep': {
    content: 'You learn that Halric is plotting to crown a puppet.',
    costHours: 2,
    unlocksFacts: ['halric-plotting-coronation'],
    unlocksThreats: ['halric-coronation']
  },
  'expensive-investigation': {
    content: 'A long evening of conversation reveals little.',
    costHours: 50
  }
};

// ---------- isLinkOpened ----------

console.log('--- isLinkOpened ---');
{
  const s = makeState();
  ok('not opened initially', !isLinkOpened(s, 1, 'ow-village'));
  s.openedLinks['1'] = ['ow-village'];
  ok('opened after marking', isLinkOpened(s, 1, 'ow-village'));
  ok('different beat -> not opened', !isLinkOpened(s, 2, 'ow-village'));
  ok('numeric vs string beatNumber treated equivalently',
     isLinkOpened(s, '1', 'ow-village'));
}

// ---------- basic free-link investigation ----------

console.log('\n--- free-link investigation (costHours=0) ---');
{
  const s = makeState();
  const before = s.clockHours;
  const r = applyInvestigation(s, bundle, {
    beatNumber: 1, linkId: 'ow-village', linkContents, currentHour: 0
  });
  ok('returns ok',                  r.ok === true);
  ok('not alreadyOpened',           r.alreadyOpened === false);
  ok('content returned',            r.content.includes('Quiet'));
  ok('no cost applied',             r.costHoursApplied === 0);
  ok('clockHours unchanged',        s.clockHours === before);
  ok('no unlocks reported',         r.unlocksFacts.length === 0 && r.unlocksThreats.length === 0);
  ok('link is now marked opened',   isLinkOpened(s, 1, 'ow-village'));
  ok('tickResults null (no cost)',  r.tickResults === null);
}

// ---------- idempotency ----------

console.log('\n--- idempotency: second click is a no-op ---');
{
  const s = makeState();
  s.clockHours = 80;
  applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'sera-bible', linkContents, currentHour: 0 });
  const after1 = s.clockHours;
  ok('first click cost 1 hour',     after1 === 79);

  const r2 = applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'sera-bible', linkContents, currentHour: 1 });
  ok('second click ok',             r2.ok === true);
  ok('second click alreadyOpened',  r2.alreadyOpened === true);
  ok('second click cached content', r2.content.includes('Old Faction'));
  ok('second click NO cost applied',r2.costHoursApplied === 0);
  ok('clockHours unchanged on second click', s.clockHours === after1);
  ok('link still in openedLinks (not duplicated)',
     s.openedLinks['1'].filter(id => id === 'sera-bible').length === 1);
}

console.log('\n--- idempotency: same link in different beats is independent ---');
{
  const s = makeState();
  s.clockHours = 90;
  applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'sera-bible', linkContents, currentHour: 0 });
  ok('beat 1 sera-bible opened',   isLinkOpened(s, 1, 'sera-bible'));
  ok('beat 2 sera-bible NOT opened', !isLinkOpened(s, 2, 'sera-bible'));

  // Investigate same link id in beat 2 -- should fire again with full cost
  const before2 = s.clockHours;
  const r = applyInvestigation(s, bundle, { beatNumber: 2, linkId: 'sera-bible', linkContents, currentHour: 1 });
  ok('beat 2 click is fresh (not alreadyOpened)', r.alreadyOpened === false);
  ok('beat 2 click costs 1 hour', s.clockHours === before2 - 1);
}

// ---------- error: link not found ----------

console.log('\n--- error: linkId not in linkContents ---');
{
  const s = makeState();
  const r = applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'no-such-link', linkContents, currentHour: 0 });
  ok('ok=false',          r.ok === false);
  ok('error message references link',
     typeof r.error === 'string' && r.error.includes("no-such-link"));
  ok('clockHours unchanged on error',   s.clockHours === 90);
  ok('openedLinks unchanged on error',  Object.keys(s.openedLinks).length === 0);
}

console.log('\n--- error: missing linkId ---');
{
  const s = makeState();
  const r = applyInvestigation(s, bundle, { beatNumber: 1, linkId: '', linkContents, currentHour: 0 });
  ok('empty linkId rejected',  r.ok === false && r.error === 'linkId required');
}

console.log('\n--- error: missing linkContents ---');
{
  const s = makeState();
  const r = applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'x', linkContents: null, currentHour: 0 });
  ok('null linkContents rejected', r.ok === false && r.error === 'linkContents required');
}

console.log('\n--- error: missing beatNumber ---');
{
  const s = makeState();
  const r = applyInvestigation(s, bundle, { linkId: 'ow-village', linkContents, currentHour: 0 });
  ok('missing beatNumber rejected', r.ok === false && r.error === 'beatNumber required');
}

// ---------- unlocksFacts ----------

console.log('\n--- unlocksFacts ---');
{
  const s = makeState();
  const r = applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'ow-pin', linkContents, currentHour: 0 });
  ok('fact added to playerKnowledge.investigatedFacts',
     s.playerKnowledge.investigatedFacts.includes('rider-wears-old-faction-pin'));
  ok('return reports applied facts',
     r.unlocksFacts.includes('rider-wears-old-faction-pin'));
}

console.log('\n--- unlocksFacts: dedup against existing facts ---');
{
  const s = makeState();
  s.playerKnowledge.investigatedFacts = ['rider-wears-old-faction-pin'];
  const r = applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'ow-pin', linkContents, currentHour: 0 });
  ok('fact not duplicated',
     s.playerKnowledge.investigatedFacts.filter(f => f === 'rider-wears-old-faction-pin').length === 1);
  ok('return reports no NEW facts',
     r.unlocksFacts.length === 0);
}

// ---------- unlocksThreats ----------

console.log('\n--- unlocksThreats ---');
{
  const s = makeState();
  s.clockHours = 90;
  seedThreatsFromBundle(s, bundle);

  const r = applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'investigate-keep', linkContents, currentHour: 0 });
  ok('halric-coronation now knownToPlayer',
     s.threats['halric-coronation'].knownToPlayer === true);
  ok('threat id added to playerKnowledge.knownThreatIds',
     s.playerKnowledge.knownThreatIds.includes('halric-coronation'));
  ok('return reports applied threats',
     r.unlocksThreats.includes('halric-coronation'));
  ok('costHours applied (cost=2)',
     r.costHoursApplied === 2 && s.clockHours === 88);
}

console.log('\n--- unlocksThreats: already-known threat does not double-add ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  s.threats['halric-coronation'].knownToPlayer = true;
  s.playerKnowledge.knownThreatIds.push('halric-coronation');

  const r = applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'investigate-keep', linkContents, currentHour: 0 });
  ok('return reports no NEW threats revealed (already known)',
     r.unlocksThreats.length === 0);
  ok('knownThreatIds not duplicated',
     s.playerKnowledge.knownThreatIds.filter(id => id === 'halric-coronation').length === 1);
}

// ---------- world tick on cost ----------

console.log('\n--- world tick during costly investigation ---');
{
  const s = makeState();
  s.clockHours = 90;
  seedThreatsFromBundle(s, bundle);

  // costHours=2 -> threat progress should advance by 2
  applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'investigate-keep', linkContents, currentHour: 0 });
  ok('threat progress advanced by costHours',
     s.threats['halric-coronation'].progress === 2);
}

console.log('\n--- world tick: scheduled event fires when investigation pushes past fireAtHour ---');
{
  const s = makeState();
  s.clockHours = 90;     // elapsed = 96-90 = 6
  seedThreatsFromBundle(s, bundle);
  seedScheduledEventsFromBundle(s, bundle);

  // Investigate a link costing 50h (clamped at clockHours=90 -> applies 50)
  // After: clockHours=40, elapsed=56. Comet event (fireAtHour=24) should have fired.
  const r = applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'expensive-investigation', linkContents, currentHour: 6 });
  ok('costHours applied = 50',  r.costHoursApplied === 50);
  ok('clockHours = 40',         s.clockHours === 40);
  ok('comet event fired during investigation tick',
     s.scheduledEvents.find(e => e.id === 'comet-near-zenith-24h').status === 'fired');
  ok('worldStateDelta from comet event applied',
     s.worldState.cometStage === 'near-zenith');
  ok('tickResults reports event tick',
     r.tickResults?.eventTick?.fired?.length >= 1);
}

console.log('\n--- world tick: cost clamped at remaining clockHours ---');
{
  const s = makeState();
  s.clockHours = 10;
  seedThreatsFromBundle(s, bundle);

  // Request 50, only 10 available -> applies 10, clockHours=0
  const r = applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'expensive-investigation', linkContents, currentHour: 86 });
  ok('costHoursApplied clamped to remaining', r.costHoursApplied === 10);
  ok('clockHours floored at 0',               s.clockHours === 0);
  ok('threat advanced by clamped amount (10)',
     s.threats['halric-coronation'].progress === 10);
}

// ---------- multi-link in same beat is independent ----------

console.log('\n--- multi-link same beat is independent ---');
{
  const s = makeState();
  s.clockHours = 90;
  applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'ow-village', linkContents, currentHour: 0 });
  applyInvestigation(s, bundle, { beatNumber: 1, linkId: 'ow-pin',     linkContents, currentHour: 0 });
  ok('both links recorded in same beat',
     s.openedLinks['1'].length === 2 &&
     s.openedLinks['1'].includes('ow-village') &&
     s.openedLinks['1'].includes('ow-pin'));
}

// ---------- summary ----------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
