// Phase F test suite for the knowledge layer.
// Run: node server/tools/test-knowledge-layer.mjs

import {
  isNpcInScene,
  scopedNpcView,
  knownThreatView,
  recentRevelations,
  recentInvestigatedFacts,
  recentRumors,
  buildKnowledgeView
} from '../lib/knowledge-layer.mjs';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}${detail ? '\n  ' + detail : ''}`); fail++; }
}

// ---------- fixtures ----------

function makeBundle() {
  return {
    characters: [
      { id: 'sera',                name: 'Sera',   role: 'Messenger / Guide', notes: 'Will not bend rules.' },
      { id: 'high-advisor-halric', name: 'Halric', role: 'Antagonist',        notes: 'Patient, cold.' },
      { id: 'king-aldric',         name: 'King Aldric', role: 'Dying king' }
    ],
    threats: [
      { id: 'halric-coronation', displayName: "Halric's Plan", icon: 'crown-broken' },
      { id: 'plague-spread',     displayName: 'Plague',        icon: 'plague' }
    ]
  };
}

function makeState() {
  return {
    gameId: 'test', worldName: 'ember-crown',
    turnNumber: 4, lastAppliedLogTurn: 4,
    clockHours: 56, distanceToKing: 47,
    condition: 'tired', location: "Wren's Hollow",
    assets: ['hunting knife', 'cloak'], lastChoiceRisk: 'risky',
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
      },
      'plague-spread': {
        progress: 20, currentPhase: 'Whispered', slowedBy: 0,
        knownToPlayer: false, revealedAtHour: null,
        completed: false, completedAt: null, authorSource: 'authored'
      }
    },
    scheduledEvents: [],
    pendingRevelations: [],
    playerKnowledge: {
      knownThreatIds: ['halric-coronation'],
      witnessedEvents: [
        { eventId: 'comet-near-zenith-24h', atHour: 24, strength: 'ambient', summary: 'comet hangs lower' },
        { eventId: 'king-decline-48h',      atHour: 48, strength: 'loud',    summary: 'bells toll' }
      ],
      rumors: [{ fact: 'gates are closing', source: 'merchant', atHour: 30, confidence: 'suspected' }],
      investigatedFacts: ['rider-wears-old-faction-pin', 'halric-plotting-coronation']
    },
    npcStates: {
      sera: {
        location: "Wren's Hollow", status: 'wary', motivationDelta: null,
        currentKnowledge: [{ fact: 'king is being poisoned', confidence: 'certain', source: 'authored' }]
      },
      'high-advisor-halric': {
        location: "Vael's Reach keep", status: 'scheming', motivationDelta: 'impatient',
        currentKnowledge: [{ fact: 'dreamer exists somewhere', confidence: 'certain', source: 'authored' }]
      }
    },
    runHistory: { threatsCompleted: [], threatsStopped: [], threatsNeverLearned: [], counterfactualsFiredKnown: [], counterfactualsFiredSilent: [] },
    terminalState: null
  };
}

const bundle = makeBundle();

// ---------- isNpcInScene ----------

console.log('--- isNpcInScene ---');
ok('exact match -> true',
   isNpcInScene("Wren's Hollow", "Wren's Hollow") === true);
ok('npc location is substring of player location -> true',
   isNpcInScene("Wren's Hollow", "Wren's Hollow (own home)") === true);
ok('player location is substring of npc location -> true',
   isNpcInScene("Wren's Hollow (own home)", "Wren's Hollow") === true);
ok('case-insensitive -> true',
   isNpcInScene("WREN'S HOLLOW", "wren's hollow") === true);
ok('different locations -> false',
   isNpcInScene("Vael's Reach keep", "Wren's Hollow") === false);
ok('null npc location -> false', isNpcInScene(null, "anywhere") === false);
ok('null player location -> false', isNpcInScene("anywhere", null) === false);
ok('empty strings -> false', isNpcInScene("", "") === false);

// ---------- scopedNpcView ----------

console.log('\n--- scopedNpcView: basic split ---');
{
  const s = makeState();
  const v = scopedNpcView(s, bundle);
  ok('sera is in-scene (location matches player)', Boolean(v.inScene.sera));
  ok('halric is off-screen', Boolean(v.offScreen['high-advisor-halric']));
  ok('off-screen npc has no currentKnowledge field',
     !('currentKnowledge' in v.offScreen['high-advisor-halric']));
  ok('off-screen npc has no notes field',
     !('notes' in v.offScreen['high-advisor-halric']));
  ok('off-screen has lastKnownLocation',
     v.offScreen['high-advisor-halric'].lastKnownLocation === "Vael's Reach keep");
  ok('off-screen has lastKnownStatus',
     v.offScreen['high-advisor-halric'].lastKnownStatus === 'scheming');
}

console.log('\n--- scopedNpcView: in-scene NPC has full knowledge + notes ---');
{
  const s = makeState();
  const v = scopedNpcView(s, bundle);
  ok('in-scene currentKnowledge present',
     Array.isArray(v.inScene.sera.currentKnowledge) && v.inScene.sera.currentKnowledge.length === 1);
  ok('in-scene currentKnowledge fact preserved',
     v.inScene.sera.currentKnowledge[0].fact === 'king is being poisoned');
  ok('in-scene includes character notes from bundle',
     v.inScene.sera.notes === 'Will not bend rules.');
  ok('in-scene includes character role from bundle',
     v.inScene.sera.role === 'Messenger / Guide');
}

console.log('\n--- scopedNpcView: off-screen never leaks knowledge ---');
{
  const s = makeState();
  // Move sera off-screen
  s.npcStates.sera.location = 'somewhere far';
  const v = scopedNpcView(s, bundle);
  ok('sera now off-screen', Boolean(v.offScreen.sera));
  ok('sera off-screen has NO currentKnowledge',
     !('currentKnowledge' in v.offScreen.sera));
  ok('sera not in inScene anymore', !v.inScene.sera);
}

console.log('\n--- scopedNpcView: bundle character missing -> id used as fallback ---');
{
  const s = makeState();
  s.npcStates['mystery-npc'] = { location: "Wren's Hollow", status: 'alive', currentKnowledge: [] };
  const v = scopedNpcView(s, bundle);
  ok('unknown bundle character -> name falls back to id',
     v.inScene['mystery-npc'].name === 'mystery-npc');
  ok('unknown bundle character -> notes is null',
     v.inScene['mystery-npc'].notes === null);
}

// ---------- knownThreatView ----------

console.log('\n--- knownThreatView ---');
{
  const s = makeState();
  const v = knownThreatView(s, bundle);
  ok('only known threats included',
     v.length === 1 && v[0].id === 'halric-coronation');
  ok('plague NOT included (knownToPlayer=false)',
     !v.some(t => t.id === 'plague-spread'));
  ok('display metadata pulled from bundle',
     v[0].displayName === "Halric's Plan" && v[0].icon === 'crown-broken');
  ok('currentPhase carried over',
     v[0].currentPhase === 'Brewing');
  ok('isVisibleInHud true (known + effective>0 + not completed)',
     v[0].isVisibleInHud === true);
  ok('completed false',
     v[0].completed === false);
}

console.log('\n--- knownThreatView: slowed past 0 -> not visible in HUD ---');
{
  const s = makeState();
  s.threats['halric-coronation'].slowedBy = 100;  // way more than progress (36)
  const v = knownThreatView(s, bundle);
  ok('threat still in view (knownToPlayer)', v.length === 1);
  ok('isVisibleInHud false (effective=0)',   v[0].isVisibleInHud === false);
}

console.log('\n--- knownThreatView: completed threat -> not visible in HUD ---');
{
  const s = makeState();
  s.threats['halric-coronation'].completed = true;
  const v = knownThreatView(s, bundle);
  ok('completed threat still in view',  v.length === 1);
  ok('isVisibleInHud false (completed)', v[0].isVisibleInHud === false);
  ok('completed flag true',              v[0].completed === true);
}

console.log('\n--- knownThreatView: stale knownThreatIds (threat removed) ignored gracefully ---');
{
  const s = makeState();
  s.playerKnowledge.knownThreatIds.push('no-such-threat');
  const v = knownThreatView(s, bundle);
  ok('phantom threat id is skipped, no crash',
     v.length === 1 && v[0].id === 'halric-coronation');
}

// ---------- recentRevelations ----------

console.log('\n--- recentRevelations ---');
{
  const s = makeState();
  ok('sinceHour=0 returns all',         recentRevelations(s, { sinceHour: 0 }).length === 2);
  ok('sinceHour=30 returns 1 (king-decline at 48)',
     recentRevelations(s, { sinceHour: 30 }).length === 1);
  ok('sinceHour=49 returns 0',          recentRevelations(s, { sinceHour: 49 }).length === 0);
  ok('default sinceHour returns all',   recentRevelations(s).length === 2);
}

console.log('\n--- recentInvestigatedFacts / recentRumors ---');
{
  const s = makeState();
  ok('investigatedFacts (default count) returns all',
     recentInvestigatedFacts(s).length === 2);
  ok('investigatedFacts count=1 returns last 1',
     recentInvestigatedFacts(s, { count: 1 })[0] === 'halric-plotting-coronation');
  ok('rumors returned in full',
     recentRumors(s).length === 1 && recentRumors(s)[0].fact === 'gates are closing');
}

// ---------- buildKnowledgeView (full assembly) ----------

console.log('\n--- buildKnowledgeView: assembled view ---');
{
  const s = makeState();
  const view = buildKnowledgeView(s, bundle, { sinceHour: 30 });
  ok('leanState.clockHours present', view.leanState.clockHours === 56);
  ok('leanState.condition present',  view.leanState.condition === 'tired');
  ok('leanState.location present',   view.leanState.location === "Wren's Hollow");
  ok('leanState.lastChoiceRisk present', view.leanState.lastChoiceRisk === 'risky');
  ok('leanState does NOT expose distanceToKing (engine-internal)',
     !('distanceToKing' in view.leanState));
  ok('worldState passed through',    view.worldState.timeOfDay === 'dusk');
  ok('knownThreats has 1 entry',     view.knownThreats.length === 1);
  ok('npcs split correctly',
     Boolean(view.npcs.inScene.sera) && Boolean(view.npcs.offScreen['high-advisor-halric']));
  ok('recentRevelations honors sinceHour',
     view.recentRevelations.length === 1);
  ok('investigatedFacts present',    view.investigatedFacts.length === 2);
  ok('rumors present',               view.rumors.length === 1);
  ok('hudChanges defaults to []',    Array.isArray(view.hudChanges) && view.hudChanges.length === 0);
}

console.log('\n--- buildKnowledgeView: hudChanges passed through ---');
{
  const s = makeState();
  const view = buildKnowledgeView(s, bundle, {
    hudChanges: [{ threatId: 'halric-coronation', change: 'resurgent' }]
  });
  ok('hudChanges array passed through',
     view.hudChanges.length === 1 && view.hudChanges[0].change === 'resurgent');
}

// ---------- structural leak check ----------

console.log('\n--- structural leak protection ---');
{
  // Halric is off-screen and has explicit currentKnowledge in state.
  // The view MUST NOT include that field anywhere.
  const s = makeState();
  const view = buildKnowledgeView(s, bundle);
  const halricView = view.npcs.offScreen['high-advisor-halric'];
  ok('halric off-screen view exists',                  Boolean(halricView));
  ok('halric off-screen view has NO currentKnowledge', !('currentKnowledge' in halricView));
  // And no other corner of the view should expose halric's knowledge either
  const serialized = JSON.stringify(view);
  ok('halric currentKnowledge fact NOT in serialized view',
     !serialized.includes('dreamer exists somewhere'),
     `view leaked: ${serialized.includes('dreamer exists somewhere')}`);
}

{
  // Plague threat is unknown to player. View MUST NOT expose its name or progress.
  const s = makeState();
  const view = buildKnowledgeView(s, bundle);
  const serialized = JSON.stringify(view);
  ok('unknown plague threat name NOT in serialized view',
     !serialized.includes('Plague'));
  ok('plague threat id NOT in serialized view',
     !serialized.includes('plague-spread'));
}

{
  // Mutating the returned view does NOT mutate state (assets is a copy).
  const s = makeState();
  const view = buildKnowledgeView(s, bundle);
  view.leanState.assets.push('STOLEN');
  ok('mutating view.leanState.assets does not mutate state.assets',
     !s.assets.includes('STOLEN'));
}

// ---------- summary ----------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
