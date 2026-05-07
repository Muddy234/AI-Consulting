// Phase G test suite for the objective prompt composer.
// Run: node server/tools/test-objective-prompt-composer.mjs
//
// "Snapshot" approach: render the prompt for a known fixture and assert
// section presence + key content. Avoids brittle full-string equality
// while still catching structural drift.

import {
  composeSystemPrompt,
  composeUserPrompt,
  composePrompt,
  PROSE_DISCIPLINE,
  NPC_INVENTION_RULES,
  KNOWLEDGE_ISOLATION_RULE,
  LETHALITY_BUDGET,
  CHOICE_AUTHORING,
  HYPERLINK_INSTRUCTION,
  COUNTERFACTUAL_RESTRAINT,
  MACRO_THREAT_AUTHORING,
  ENDING_TRIGGER,
  OUTPUT_SCHEMA_REMINDER
} from '../lib/objective-prompt-composer.mjs';
import { loadWorldBundle } from '../lib/world-bundle.mjs';
import { DEFAULT_WORLD } from '../lib/config.mjs';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}${detail ? '\n  ' + detail : ''}`); fail++; }
}
function contains(haystack, needle) { return String(haystack).includes(needle); }
function notContains(haystack, needle) { return !String(haystack).includes(needle); }

// ---------- fixtures ----------

const bundle = loadWorldBundle(DEFAULT_WORLD);

function makeState() {
  return {
    gameId: 'snap-test', worldName: 'ember-crown',
    turnNumber: 4, lastAppliedLogTurn: 4,
    clockHours: 56, distanceToKing: 47,
    condition: 'tired', location: "Wren's Hollow",
    assets: ['hunting knife', 'cloak', 'ally:sera'],
    lastChoiceRisk: 'risky',
    worldState: {
      timeOfDay: 'dusk', cometStage: 'near-zenith',
      kingStatus: 'dying', crownStatus: 'dormant', antagonistPower: 'advisor',
      majorEvents: ['Sera met player at gate', 'Player rode east with Sera']
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

const lastChoice = {
  label: 'A', risk: 'risky', text: 'Push on through the night.',
  otherChoices: [
    { label: 'B', risk: 'controlled', text: 'Make camp here.' },
    { label: 'C', risk: 'desperate',  text: 'Cut through the Dead Pines alone.' }
  ]
};

const recentHistory = [
  {
    title: "I. The Riders",
    prose: 'You wake to the sound of your own name being called. Outside, dawn is breaking thin and red over Wren\'s Hollow.'
  },
  {
    title: "II. The Eastern Road",
    prose: 'You have been riding for twelve hours. The road thins to a deer path; Sera reins her horse beside yours.'
  }
];

const hudChanges = [
  { threatId: 'halric-coronation', change: 'resurgent' }
];

// ============================================================
// SYSTEM PROMPT
// ============================================================

console.log('--- system prompt: structure ---');
{
  const sys = composeSystemPrompt(bundle);

  ok('voice block present',                       contains(sys, '[VOICE]'));
  ok('prose discipline block present',            contains(sys, '[PROSE DISCIPLINE]'));
  ok('objective block present',                   contains(sys, '[OBJECTIVE]'));
  ok('objective primary line included',           contains(sys, 'Reach the dying King Aldric'));
  ok('setting & tone block present',              contains(sys, '[SETTING & TONE]'));
  ok('world bible block present',                 contains(sys, '[WORLD BIBLE]'));
  ok('world constraints block present',           contains(sys, '[WORLD CONSTRAINTS]'));
  ok('adaptation rules block present',            contains(sys, '[ADAPTATION RULES]'));
  ok('character roster block present',            contains(sys, '[CHARACTER ROSTER]'));
  ok('prose discipline included',                 contains(sys, PROSE_DISCIPLINE));
  ok('npc invention rules included',              contains(sys, NPC_INVENTION_RULES));
  ok('knowledge isolation rule included',         contains(sys, KNOWLEDGE_ISOLATION_RULE));
  ok('lethality budget included',                 contains(sys, LETHALITY_BUDGET));
  ok('choice authoring included',                 contains(sys, CHOICE_AUTHORING));
  ok('hyperlink instruction included',            contains(sys, HYPERLINK_INSTRUCTION));
  ok('counterfactual restraint included',         contains(sys, COUNTERFACTUAL_RESTRAINT));
  ok('macro-threat authoring included',           contains(sys, MACRO_THREAT_AUTHORING));
  ok('ending trigger included',                   contains(sys, ENDING_TRIGGER));
  ok('output schema reminder included',           contains(sys, OUTPUT_SCHEMA_REMINDER));
}

console.log('\n--- system prompt: difficulty layering (foreshadowing + tiers + show-don\'t-tell) ---');
{
  const sys = composeSystemPrompt(bundle);
  // PROSE DISCIPLINE: the show-don't-tell mantra
  ok('prose discipline says imply, never announce',
     contains(sys, 'Imply, never announce'));
  ok('prose discipline applies to hyperlinks',
     contains(sys.toLowerCase(), 'hyperlink'));
  // LETHALITY: risk-tier ladder
  ok('lethality has all three risk tiers',
     contains(sys, 'controlled') && contains(sys, 'risky') && contains(sys, 'desperate'));
  ok('lethality names the controlled ceiling explicitly',
     contains(sys, 'NEVER push condition to wounded') ||
     contains(sys, 'NEVER terminal'));
  ok('lethality has the foreshadowing contract',
     contains(sys, 'foreshadowing contract'));
  ok('lethality has knowledge-mitigates rule',
     contains(sys, 'Knowledge mitigates') ||
     contains(sys, 'investigatedFacts'));
  ok('lethality has the show-don\'t-name resolution rule',
     contains(sys, 'never names the foreshadowed thing') ||
     contains(sys, 'chain takes your leg'));
  ok('lethality has named-loss vocabulary',
     contains(sys, 'spotted') &&
     contains(sys, 'fled-and-caught') &&
     contains(sys, 'shortcut-broke-leg'));
  // CHOICE AUTHORING
  ok('choice authoring tells model to signal risk through tone',
     contains(sys, 'signals its risk through tone'));
  ok('choice authoring requires desperate language in choice text',
     contains(sys, 'risk=\'desperate\'') ||
     contains(sys, "broadcasts the gamble"));
  ok('choice authoring defaults to one controlled per beat',
     contains(sys, "at least one 'controlled' option"));
  // HYPERLINK
  ok('hyperlink shows the bad example label',
     contains(sys, 'bad:'));
  ok('hyperlink shows the good example label',
     contains(sys, 'good:'));
  ok('hyperlink mentions show concrete details',
     contains(sys, 'SHOW concrete details'));
  ok('hyperlink references foreshadowing contract back-reference',
     contains(sys, 'foreshadowing contract'));
  // ENDING
  ok('ending tells model to name the deal',
     contains(sys, 'NAME THE DEAL'));
  ok('ending has imply-never-announce close',
     contains(sys, 'Imply, never announce'));
  // OUTPUT
  ok('output reminder mentions directorReasoning for foreshadowing notes',
     contains(sys, 'directorReasoning') &&
     contains(sys, 'foreshadowing'));
}

console.log('\n--- system prompt: rev-2 removals ---');
{
  const sys = composeSystemPrompt(bundle);
  ok('no pacingBudget mention',         notContains(sys, 'pacingBudget'));
  ok('no climaxByBeat mention',         notContains(sys, 'climaxByBeat'));
  ok('no quadrant authoring mention',   notContains(sys, 'selfOther') && notContains(sys, 'assertYield'));
  ok('no risk-badge UI mention',        notContains(sys.toLowerCase(), 'risk badge'));
  ok('no stake-clause authoring',       notContains(sys.toLowerCase(), 'stake clause'));
  ok('no predicted-delta authoring',    notContains(sys, 'predictedDistanceDelta') && notContains(sys, 'predictedClockHours'));
  ok('no movesRemaining mention',       notContains(sys, 'movesRemaining'));
}

console.log('\n--- system prompt: character roster from bundle ---');
{
  const sys = composeSystemPrompt(bundle);
  ok('lists sera by id',                contains(sys, '- sera'));
  ok('lists king-aldric by id',         contains(sys, '- king-aldric'));
  ok('lists high-advisor-halric by id', contains(sys, '- high-advisor-halric'));
  ok('roster is id-only (no notes)',
     notContains(sys.split('[CHARACTER ROSTER]')[1].split('[')[0], 'Will not bend rules'));
}

// ============================================================
// USER PROMPT
// ============================================================

console.log('\n--- user prompt: scoped NPC bibles ---');
{
  const usr = composeUserPrompt(makeState(), bundle, { recentHistory, lastChoice, hudChanges, sinceHour: 30 });

  ok('in-scene block header present',   contains(usr, '[CHARACTER BIBLES - IN SCENE]'));
  ok('off-screen block header present', contains(usr, '[OFF-SCREEN NPCS]'));
  ok('sera in in-scene block',          contains(usr, 'sera - Sera'));
  ok('sera Knows: line includes her fact',
     contains(usr, '"king is being poisoned"'));
  ok('sera notes line included (in-scene gets notes)',
     contains(usr, 'Will not bend rules'));
  ok('halric in off-screen block',
     contains(usr, '- high-advisor-halric (High Advisor Halric'));
  ok('halric off-screen line shows lastKnown location',
     contains(usr, "Vael's Reach keep"));
}

console.log('\n--- user prompt: leak protection (off-screen NPC has no knowledge) ---');
{
  const usr = composeUserPrompt(makeState(), bundle, { recentHistory, lastChoice, hudChanges, sinceHour: 30 });
  // Halric's currentKnowledge fact must NOT appear anywhere in the user prompt
  ok('halric currentKnowledge NOT in prompt',
     notContains(usr, 'dreamer exists somewhere'));
  // halric notes (his "patient, cold" authoring note) is also off-stage
  ok('halric notes NOT in prompt',
     notContains(usr, 'Patient, cold'));
}

console.log('\n--- user prompt: lean current state ---');
{
  const usr = composeUserPrompt(makeState(), bundle, { recentHistory, lastChoice, hudChanges, sinceHour: 30 });
  ok('current state block present',     contains(usr, '[CURRENT STATE]'));
  ok('shows clockHours',                contains(usr, 'Hours on clock: 56'));
  ok('shows condition',                 contains(usr, 'Condition:      tired'));
  ok('shows location',                  contains(usr, 'Wren\'s Hollow'));
  ok('shows assets',                    contains(usr, 'hunting knife') && contains(usr, 'ally:sera'));
  ok('shows last choice tier',          contains(usr, 'Last choice tier: risky'));
  ok('does NOT expose distanceToKing (engine-internal)',
     notContains(usr, 'distanceToKing') && notContains(usr, 'Distance to king'));
  ok('does NOT expose turnNumber',      notContains(usr, 'Turn number'));
}

console.log('\n--- user prompt: world state ---');
{
  const usr = composeUserPrompt(makeState(), bundle, { recentHistory, lastChoice, hudChanges, sinceHour: 30 });
  ok('world state header present',      contains(usr, '[WORLD STATE]'));
  ok('time of day rendered',            contains(usr, 'Time of day: dusk'));
  ok('comet stage rendered',            contains(usr, 'Comet stage: near-zenith'));
  ok('king status rendered',            contains(usr, 'King status: dying'));
  ok('major events listed',             contains(usr, 'Sera met player at gate'));
}

console.log('\n--- user prompt: known threats ---');
{
  const usr = composeUserPrompt(makeState(), bundle, { recentHistory, lastChoice, hudChanges, sinceHour: 30 });
  ok('known threats block present',     contains(usr, '[KNOWN THREATS]'));
  ok('halric plan rendered',            contains(usr, "Halric's Plan"));
  ok('halric phase label rendered',     contains(usr, 'phase "Brewing"'));
  ok('threat reminder: phase is qualitative',
     contains(usr.toLowerCase(), 'qualitative') && contains(usr, 'engine owns it'));
}

console.log('\n--- user prompt: living world (revelations + hud changes) ---');
{
  const usr = composeUserPrompt(makeState(), bundle, { recentHistory, lastChoice, hudChanges, sinceHour: 30 });
  ok('living world block present (events at/after sinceHour=30)',
     contains(usr, '[LIVING WORLD'));
  ok('king-decline revelation present (atHour=48 >= 30)',
     contains(usr, 'bells toll'));
  ok('comet revelation NOT present (atHour=24 < 30)',
     notContains(usr, 'comet hangs lower'));
  ok('hud changes block present',       contains(usr, '[HUD CHANGES'));
  ok('resurgent threat noted',          contains(usr, 'returning into view'));
}

console.log('\n--- user prompt: investigated facts + rumors ---');
{
  const usr = composeUserPrompt(makeState(), bundle, { recentHistory, lastChoice, hudChanges, sinceHour: 30 });
  ok('investigated facts block present', contains(usr, '[PLAYER HAS INVESTIGATED]'));
  ok('investigated fact 1 listed',
     contains(usr, 'rider-wears-old-faction-pin'));
  ok('investigated fact 2 listed',
     contains(usr, 'halric-plotting-coronation'));
  ok('rumors block present',             contains(usr, '[RUMORS'));
  ok('rumor source + hour rendered',
     contains(usr, 'gates are closing') && contains(usr, 'from merchant'));
}

console.log('\n--- user prompt: recent history ---');
{
  const usr = composeUserPrompt(makeState(), bundle, { recentHistory, lastChoice, hudChanges, sinceHour: 30 });
  ok('recent history block present',    contains(usr, '[RECENT HISTORY'));
  ok('beat 1 title rendered',           contains(usr, 'I. The Riders'));
  ok('beat 1 prose rendered',           contains(usr, 'thin and red over'));
  ok('beat 2 title rendered',           contains(usr, 'II. The Eastern Road'));
}

console.log('\n--- user prompt: last turn block ---');
{
  const usr = composeUserPrompt(makeState(), bundle, { recentHistory, lastChoice, hudChanges, sinceHour: 30 });
  ok('last turn block present',         contains(usr, '[LAST TURN'));
  ok('chosen option text rendered',     contains(usr, 'Push on through the night'));
  ok('chosen risk tier rendered',       contains(usr, 'risk: risky'));
  ok('rejected options rendered',
     contains(usr, 'Make camp here') && contains(usr, 'Cut through the Dead Pines'));
}

console.log('\n--- user prompt: ending capstone ---');
{
  const usr = composeUserPrompt(makeState(), bundle, { recentHistory, lastChoice, hudChanges, sinceHour: 30 });
  ok('user prompt ends with "Generate the next beat."',
     usr.trimEnd().endsWith('Generate the next beat.'));
}

// ============================================================
// EDGE CASES
// ============================================================

console.log('\n--- user prompt: turn-2 (no recent history yet, no last choice) ---');
{
  const s = makeState();
  s.turnNumber = 2;
  const usr = composeUserPrompt(s, bundle, { recentHistory: [], lastChoice: null, hudChanges: [], sinceHour: 0 });
  ok('omits recent history block when empty',  notContains(usr, '[RECENT HISTORY'));
  ok('omits last turn block when null',        notContains(usr, '[LAST TURN'));
  ok('omits hud changes when empty',           notContains(usr, '[HUD CHANGES'));
  ok('still has current state',                contains(usr, '[CURRENT STATE]'));
  ok('still ends with generate-next-beat cap', usr.trimEnd().endsWith('Generate the next beat.'));
}

console.log('\n--- user prompt: no in-scene NPCs ---');
{
  const s = makeState();
  s.npcStates = {};
  const usr = composeUserPrompt(s, bundle, {});
  ok('renders empty in-scene message',
     contains(usr, '(no persistent NPCs in scene)'));
  ok('omits off-screen block when none',
     notContains(usr, '[OFF-SCREEN NPCS]'));
}

console.log('\n--- user prompt: no known threats ---');
{
  const s = makeState();
  s.playerKnowledge.knownThreatIds = [];
  const usr = composeUserPrompt(s, bundle, {});
  ok('omits known threats block when none', notContains(usr, '[KNOWN THREATS]'));
}

// ============================================================
// composePrompt (full bundle)
// ============================================================

console.log('\n--- composePrompt: returns { system, user } ---');
{
  const p = composePrompt(makeState(), bundle, { recentHistory, lastChoice, hudChanges, sinceHour: 30 });
  ok('has system field',  typeof p.system === 'string' && p.system.length > 100);
  ok('has user field',    typeof p.user === 'string' && p.user.length > 100);
  ok('system has rules',  contains(p.system, '[LETHALITY & CONSEQUENCE]'));
  ok('user has state',    contains(p.user, '[CURRENT STATE]'));
}

// ---------- summary ----------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
