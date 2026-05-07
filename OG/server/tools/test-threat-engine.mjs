// Phase D test suite for the threat engine.
// Run: node server/tools/test-threat-engine.mjs

import {
  computePhase,
  effectiveProgress,
  isVisibleInHud,
  initThreatRuntime,
  seedThreatsFromBundle,
  tickThreats,
  revealThreat,
  applyOnComplete
} from '../lib/threat-engine.mjs';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}${detail ? '\n  ' + detail : ''}`); fail++; }
}
function eq(a, b)   { return JSON.stringify(a) === JSON.stringify(b); }

// ---------- fixtures ----------

function makeBundle() {
  return {
    startingClocks: { clockHours: 96 },
    threats: [
      {
        id: 'halric-coronation',
        displayName: "Halric's Plan",
        duration: 96,
        phases: [
          { atProgress: 0,  label: 'Brewing'  },
          { atProgress: 40, label: 'Moving'   },
          { atProgress: 75, label: 'Imminent' }
        ],
        onComplete: {
          worldStateDelta: { antagonistPower: 'king', kingStatus: 'dead' },
          majorEvent: 'Halric crowned his puppet. The keep flies black banners.'
        }
      },
      {
        id: 'plague-spread',
        displayName: 'Plague',
        duration: 60,
        phases: [
          { atProgress: 0,  label: 'Whispered' },
          { atProgress: 30, label: 'Spreading' }
        ],
        onComplete: {
          worldStateDelta: { kingStatus: 'dead' },
          majorEvent: 'Plague reaches the keep.'
        }
      }
    ]
  };
}

function makeState() {
  return {
    gameId: 'test', worldName: 'ember-crown',
    turnNumber: 0, lastAppliedLogTurn: 0,
    clockHours: 96, distanceToKing: 100,
    condition: 'tired', location: 'Wren\'s Hollow', assets: [],
    lastChoiceRisk: null,
    worldState: {
      timeOfDay: 'dawn', cometStage: 'approaching',
      kingStatus: 'declining', crownStatus: 'dormant', antagonistPower: 'advisor',
      majorEvents: []
    },
    threats: {},
    scheduledEvents: [],
    playerKnowledge: { knownThreatIds: [], witnessedEvents: [], rumors: [], investigatedFacts: [] },
    npcStates: {},
    runHistory: { threatsCompleted: [], threatsStopped: [], threatsNeverLearned: [], counterfactualsFiredKnown: [], counterfactualsFiredSilent: [] },
    terminalState: null
  };
}

const bundle = makeBundle();
const halric = bundle.threats[0];

// ---------- computePhase ----------

console.log('--- computePhase ---');
ok('progress=0 -> Brewing',     computePhase(0,   halric.phases) === 'Brewing');
ok('progress=39 -> Brewing',    computePhase(39,  halric.phases) === 'Brewing');
ok('progress=40 -> Moving (boundary inclusive)', computePhase(40, halric.phases) === 'Moving');
ok('progress=74 -> Moving',     computePhase(74,  halric.phases) === 'Moving');
ok('progress=75 -> Imminent',   computePhase(75,  halric.phases) === 'Imminent');
ok('progress=200 -> Imminent (above all phases)', computePhase(200, halric.phases) === 'Imminent');
ok('empty phases -> null',      computePhase(50,  []) === null);
ok('null phases -> null',       computePhase(50,  null) === null);

// ---------- effectiveProgress ----------

console.log('\n--- effectiveProgress ---');
ok('progress=10, slowed=0 -> 10',  effectiveProgress({ progress: 10, slowedBy: 0 }) === 10);
ok('progress=10, slowed=4 -> 6',   effectiveProgress({ progress: 10, slowedBy: 4 }) === 6);
ok('progress=4, slowed=10 -> 0 (clamped)', effectiveProgress({ progress: 4, slowedBy: 10 }) === 0);
ok('missing fields -> 0',          effectiveProgress({}) === 0);

// ---------- initThreatRuntime ----------

console.log('\n--- initThreatRuntime ---');
{
  const r = initThreatRuntime(halric);
  ok('progress starts at 0',         r.progress === 0);
  ok('currentPhase = first label',   r.currentPhase === 'Brewing');
  ok('slowedBy starts at 0',         r.slowedBy === 0);
  ok('knownToPlayer starts false',   r.knownToPlayer === false);
  ok('completed starts false',       r.completed === false);
  ok('authorSource defaults authored', r.authorSource === 'authored');

  const m = initThreatRuntime(halric, { authorSource: 'model' });
  ok('authorSource override works', m.authorSource === 'model');
}

// ---------- seedThreatsFromBundle ----------

console.log('\n--- seedThreatsFromBundle ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  ok('seeded both bundle threats',
    eq(Object.keys(s.threats).sort(), ['halric-coronation', 'plague-spread']));
  ok('bundle threats start with authorSource=authored',
    s.threats['halric-coronation'].authorSource === 'authored');

  // Idempotent: pre-existing runtime is preserved
  s.threats['halric-coronation'].progress = 30;
  seedThreatsFromBundle(s, bundle);
  ok('seed is idempotent (preserves existing progress)',
    s.threats['halric-coronation'].progress === 30);
}

// ---------- tick: basic progression ----------

console.log('\n--- tickThreats: basic progression ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  s.clockHours = 86;          // 10 hours have elapsed
  const r = tickThreats(s, bundle, { clockHoursDelta: 10 });
  ok('halric progress -> 10 after 10h tick',
    s.threats['halric-coronation'].progress === 10);
  ok('halric phase still Brewing at 10',
    s.threats['halric-coronation'].currentPhase === 'Brewing');
  ok('no completions on first tick',  r.completions.length === 0);
  ok('no HUD changes (threat unknown)', r.hudChanges.length === 0);
}

console.log('\n--- tickThreats: phase boundaries ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  // Tick 39h: still Brewing
  tickThreats(s, bundle, { clockHoursDelta: 39 });
  ok('phase=Brewing at 39h',
    s.threats['halric-coronation'].currentPhase === 'Brewing');

  // Tick 1 more hour to hit 40 boundary -> Moving
  tickThreats(s, bundle, { clockHoursDelta: 1 });
  ok('phase=Moving at 40h boundary',
    s.threats['halric-coronation'].currentPhase === 'Moving');

  // Tick 35 more -> 75: Imminent
  tickThreats(s, bundle, { clockHoursDelta: 35 });
  ok('phase=Imminent at 75h boundary',
    s.threats['halric-coronation'].currentPhase === 'Imminent');
}

// ---------- tick: slowdowns ----------

console.log('\n--- tickThreats: slowdowns ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);

  // 50h tick + slowdown of 12h on halric
  tickThreats(s, bundle, {
    clockHoursDelta: 50,
    threatSlowdowns: [{ threatId: 'halric-coronation', hours: 12, reason: 'messenger intercepted' }]
  });
  const t = s.threats['halric-coronation'];
  ok('progress=50 (monotonic)',  t.progress === 50);
  ok('slowedBy=12',              t.slowedBy === 12);
  ok('effectiveProgress=38',     effectiveProgress(t) === 38);
  ok('phase recomputed from effective (Brewing at 38)', t.currentPhase === 'Brewing');
}

console.log('\n--- tickThreats: multiple slowdowns same threat in one turn ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  tickThreats(s, bundle, {
    clockHoursDelta: 0,
    threatSlowdowns: [
      { threatId: 'halric-coronation', hours: 10, reason: 'a' },
      { threatId: 'halric-coronation', hours: 8,  reason: 'b' }
    ]
  });
  ok('multiple slowdowns sum (10+8=18)',
    s.threats['halric-coronation'].slowedBy === 18);
}

console.log('\n--- tickThreats: slowdown for unknown threat is ignored ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  const r = tickThreats(s, bundle, {
    clockHoursDelta: 5,
    threatSlowdowns: [{ threatId: 'no-such-threat', hours: 10, reason: 'x' }]
  });
  ok('unknown-threat slowdown does not crash',  r.completions.length === 0);
  ok('halric slowedBy unchanged',
    s.threats['halric-coronation'].slowedBy === 0);
}

// ---------- tick: completion ----------

console.log('\n--- tickThreats: completion ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  s.clockHours = 0;     // 96h elapsed
  const r = tickThreats(s, bundle, { clockHoursDelta: 96 });
  ok('halric completed at 96h',
    s.threats['halric-coronation'].completed === true);
  ok('plague completed at 96h (duration 60)',
    s.threats['plague-spread'].completed === true);
  ok('completions list has both threats',
    r.completions.length === 2);
  ok('completion carries onComplete payload',
    r.completions[0].onComplete?.majorEvent !== undefined);
  ok('completedAt stamped',
    typeof s.threats['halric-coronation'].completedAt === 'number');
}

console.log('\n--- tickThreats: slowdown delays completion ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  // 96h elapsed but halric was slowed by 12h -> effective=84 < 96 -> NOT completed
  s.clockHours = 0;
  const r = tickThreats(s, bundle, {
    clockHoursDelta: 96,
    threatSlowdowns: [{ threatId: 'halric-coronation', hours: 12, reason: 'big disruption' }]
  });
  ok('halric NOT completed when slowed past completion (effective=84)',
    s.threats['halric-coronation'].completed === false);
  ok('completion list excludes the slowed threat',
    !r.completions.some(c => c.threatId === 'halric-coronation'));
  ok('plague (no slowdown) still completed',
    s.threats['plague-spread'].completed === true);
}

console.log('\n--- tickThreats: already-completed threat is skipped ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  s.threats['halric-coronation'].completed = true;
  s.threats['halric-coronation'].progress = 96;
  const r = tickThreats(s, bundle, { clockHoursDelta: 10 });
  ok('completed threat progress is not advanced',
    s.threats['halric-coronation'].progress === 96);
  ok('completed threat is not re-emitted in completions',
    !r.completions.some(c => c.threatId === 'halric-coronation'));
}

// ---------- tick: HUD-visibility transitions ----------

console.log('\n--- tickThreats: HUD transitions ---');
{
  // Start: known and visible (progress=20, slowedBy=0)
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  s.threats['halric-coronation'].progress = 20;
  revealThreat(s, 'halric-coronation', 0);

  // Slowdown of 30 -> effective drops to max(0, 20-30) = 0 -> HUD hidden
  const r = tickThreats(s, bundle, {
    clockHoursDelta: 0,
    threatSlowdowns: [{ threatId: 'halric-coronation', hours: 30, reason: 'massive disruption' }]
  });
  ok('hudChange=hidden when slowed past 0',
    r.hudChanges.some(h => h.threatId === 'halric-coronation' && h.change === 'hidden'));
  ok('threat still knownToPlayer after hide',
    s.threats['halric-coronation'].knownToPlayer === true);

  // Now tick more time so progress catches back up: 30 hours -> progress=50, effective=20
  const r2 = tickThreats(s, bundle, { clockHoursDelta: 30 });
  ok('hudChange=resurgent when progress catches back up',
    r2.hudChanges.some(h => h.threatId === 'halric-coronation' && h.change === 'resurgent'));
}

console.log('\n--- tickThreats: hidden->visible only fires when crossing the boundary ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  s.threats['halric-coronation'].progress = 30;
  s.threats['halric-coronation'].slowedBy = 30;   // hidden (effective=0)
  revealThreat(s, 'halric-coronation', 0);

  // Steady state: still hidden, no change
  const r = tickThreats(s, bundle, { clockHoursDelta: 0 });
  ok('no HUD change when staying hidden',
    !r.hudChanges.some(h => h.threatId === 'halric-coronation'));
}

console.log('\n--- tickThreats: completion suppresses hudChange "hidden" ---');
{
  // Threat that completes shouldn't also report 'hidden' (completion is its own state)
  const s = makeState();
  seedThreatsFromBundle(s, bundle);
  revealThreat(s, 'halric-coronation', 0);
  s.threats['halric-coronation'].progress = 95;
  // 1 more hour -> completed=true; isVisibleInHud goes false because completed; no 'hidden' event
  const r = tickThreats(s, bundle, { clockHoursDelta: 1 });
  ok('threat completed in this tick',
    s.threats['halric-coronation'].completed === true);
  ok('no "hidden" hudChange when transition was due to completion',
    !r.hudChanges.some(h => h.threatId === 'halric-coronation' && h.change === 'hidden'));
}

// ---------- revealThreat ----------

console.log('\n--- revealThreat ---');
{
  const s = makeState();
  seedThreatsFromBundle(s, bundle);

  const a = revealThreat(s, 'halric-coronation', 14);
  ok('first reveal returns true',  a === true);
  ok('knownToPlayer set true',     s.threats['halric-coronation'].knownToPlayer === true);
  ok('revealedAtHour stamped',     s.threats['halric-coronation'].revealedAtHour === 14);
  ok('id added to playerKnowledge.knownThreatIds',
    s.playerKnowledge.knownThreatIds.includes('halric-coronation'));

  const b = revealThreat(s, 'halric-coronation', 20);
  ok('second reveal returns false (already known)', b === false);
  ok('revealedAtHour NOT overwritten',
    s.threats['halric-coronation'].revealedAtHour === 14);

  const c = revealThreat(s, 'no-such-threat', 5);
  ok('reveal of unknown threat id returns false', c === false);
}

// ---------- applyOnComplete ----------

console.log('\n--- applyOnComplete ---');
{
  const s = makeState();
  applyOnComplete(s, halric.onComplete);
  ok('worldState.antagonistPower set',  s.worldState.antagonistPower === 'king');
  ok('worldState.kingStatus set',       s.worldState.kingStatus === 'dead');
  ok('majorEvent appended',             s.worldState.majorEvents.includes(halric.onComplete.majorEvent));
}
{
  const s = makeState();
  // Cap at 12 majorEvents
  s.worldState.majorEvents = Array.from({ length: 12 }, (_, i) => `event-${i}`);
  applyOnComplete(s, { majorEvent: 'new event' });
  ok('majorEvents capped at 12',  s.worldState.majorEvents.length === 12);
  ok('oldest event dropped',      !s.worldState.majorEvents.includes('event-0'));
  ok('newest event present',      s.worldState.majorEvents.includes('new event'));
}

// ---------- summary ----------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
