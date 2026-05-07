// Objective prompt composer (Phase G). See OBJECTIVE_REFACTOR_PLAN.md §1.5.
//
// Splits the prompt into:
//   - system: stable per-game instructions (voice, world bible, rules,
//     output schema reference, lethality budget, hyperlink instruction,
//     counterfactual restraint, macro-threat authoring, ending trigger)
//   - user:   per-turn state (scoped character bibles, lean current state,
//     world state, known threats with phase, living-world due-revelations,
//     HUD changes for the model to acknowledge in prose, investigated
//     facts, rumors, recent history prose, last turn's chosen option +
//     alternatives, "generate the next beat" cap)
//
// Reads from the knowledge-layer view, never from raw state. Lives next
// to the rev-1 prompt-composer.mjs until Phase I retires the latter.

import { buildKnowledgeView } from './knowledge-layer.mjs';

// ============================================================
// Constant prompt sections (system prompt rules + instructions)
// ============================================================

export const NPC_INVENTION_RULES = `[NPC INVENTION RULES]
- You may name and use background NPCs in prose freely (a passing merchant,
  a kitchen mistress, a wounded soldier on the road). The world should feel
  populated.
- Background NPCs exist only in this beat's prose. They have no persistent
  state; do not assume the player can return to them later.
- Persistent NPCs — anyone you record in npcImpacts[] — must reference an
  npcId from the character bibles. Do not invent new persistent NPCs.
- If a background character becomes important, write them through the
  bundle NPCs' actions instead (e.g., Sera notices and remarks).`;

export const KNOWLEDGE_ISOLATION_RULE = `[KNOWLEDGE ISOLATION]
NPCs know only what their bibles + currentKnowledge entries tell you.
Off-screen NPCs in the [OFF-SCREEN NPCS] section deliberately have NO
knowledge field shown — they are off-stage, and you do not have access to
what they currently know. Do not have them reference facts they would not
know. Do not surface plot threads the player has not encountered.`;

export const LETHALITY_BUDGET = `[LETHALITY]
Death, traps, and jail (terminalState.kind in killed/trapped/jailed) are
only legal when the player chose 'desperate' AND failed. On 'controlled'
or 'risky' choices you may surprise the player with non-lethal
consequences — a stolen horse, a poisoned wound, an ally's trust shaken,
heat rising — but never with termination. Keep desperate outcomes
sparingly real; they should feel earned, not arbitrary.`;

export const HYPERLINK_INSTRUCTION = `[HYPERLINKS]
Author 0-6 hyperlinks per beat. Tag each by linkType:
  lore           - flavor / world-color, harmless to read
  flavor         - atmospheric noun (smell, sound, glance), no consequence
  clue           - a thread the curious player may pull
  threat-reveal  - clicking unlocks a known threat (use sparingly; reserve
                   for moments the player is brushing against a hidden one)
  npc-detail     - a deeper bible page on a present NPC
  investigation  - a costly action (set costHours > 0 in linkContents)
Most links should be lore or flavor. Use clue sparingly. Reserve
threat-reveal for genuine brushes-with-hidden-threats. Costly investigations
should feel like deliberate effort, not casual reading.
Every link in segments must have a matching entry in the corresponding
linkContents map. Link ids must be unique within a beat. Per-link content
should be 20-50 words.`;

export const COUNTERFACTUAL_RESTRAINT = `[COUNTERFACTUAL RESTRAINT]
If you author scheduled events at runtime (worldImpacts.scheduledEventsToAdd):
- Default revelation strength is 'quiet', default delay is 12-24 hours.
- Reserve 'loud' for events the player will likely encounter directly.
- Reserve 'silent' for cancelled outcomes (the saved-without-knowing case).
The world should ripple even when the player isn't watching. The player
should sometimes have to draw the causal chain themselves.`;

export const MACRO_THREAT_AUTHORING = `[MACRO-THREAT AUTHORING - use sparingly]
You may promote a major emergent situation to a persistent threat via
worldImpacts.macroThreatsToAdd - a faction whose plan you've just exposed,
an ally turned hunter, a betrayal whose consequences will tick across many
beats. Reserve this for genuine mid-run pivots, not for re-skins of
existing threats. The validator caps you at 2 model-authored macro-threats
per game.`;

export const ENDING_TRIGGER = `[ENDING TRIGGER]
If distanceToKing <= 5 after applying your deltas, set
narrativeResponse.terminalState.kind = 'reached-king' and write the
bedside scene. The mood is shaped by runHistory (which threats completed,
which the player stopped, which they never learned existed) - not by your
script.
If clockHours - clockHoursDelta <= 0, the engine forces a 'time-up'
ending on the next turn. If a forced-end threat completes off-screen, the
engine emits its own ending. Do not author 'time-up', 'killed', 'trapped',
or 'jailed' on a non-terminal beat unless the lethality budget conditions
are met.`;

export const OUTPUT_SCHEMA_REMINDER = `[OUTPUT]
Return a single JSON object matching the objective.model-output schema:
worldImpacts, npcImpacts, narrativeResponse, forwardProjection,
directorReasoning. Do not include any text outside the JSON object.
Choices: 2-4 entries with labels A..D, each carrying a risk tag
(controlled / risky / desperate) used by the lethality gate.`;

// ============================================================
// System prompt assembly
// ============================================================

export function composeSystemPrompt(bundle) {
  const sections = [
    renderVoice(bundle),
    renderObjective(bundle),
    renderSettingAndTone(bundle),
    renderWorldBible(bundle),
    renderWorldConstraints(bundle),
    renderAdaptationRules(bundle),
    renderCharacterRoster(bundle),
    NPC_INVENTION_RULES,
    KNOWLEDGE_ISOLATION_RULE,
    LETHALITY_BUDGET,
    HYPERLINK_INSTRUCTION,
    COUNTERFACTUAL_RESTRAINT,
    MACRO_THREAT_AUTHORING,
    ENDING_TRIGGER,
    OUTPUT_SCHEMA_REMINDER
  ].filter(Boolean);
  return sections.join('\n\n');
}

// ============================================================
// User prompt assembly (per-turn)
// ============================================================

export function composeUserPrompt(state, bundle, {
  recentHistory = [],
  lastChoice = null,
  hudChanges = [],
  sinceHour = 0
} = {}) {
  const view = buildKnowledgeView(state, bundle, { hudChanges, sinceHour });
  const sections = [
    renderInSceneBibles(view.npcs.inScene),
    renderOffScreenNpcs(view.npcs.offScreen),
    renderCurrentState(view.leanState),
    renderWorldState(view.worldState),
    renderKnownThreats(view.knownThreats),
    renderLivingWorld(view.recentRevelations, view.hudChanges),
    renderInvestigated(view.investigatedFacts, view.rumors),
    renderRecentHistory(recentHistory),
    renderLastTurn(lastChoice),
    `Generate the next beat.`
  ].filter(Boolean);
  return sections.join('\n\n');
}

export function composePrompt(state, bundle, opts = {}) {
  return {
    system: composeSystemPrompt(bundle),
    user:   composeUserPrompt(state, bundle, opts)
  };
}

// ============================================================
// System-section renderers
// ============================================================

function renderVoice(bundle) {
  if (!bundle?.voice) return null;
  return `[VOICE]\n${bundle.voice.trim()}`;
}

function renderObjective(bundle) {
  const o = bundle?.objective;
  if (!o) return null;
  const fail = Array.isArray(o.failModes) ? o.failModes.join(', ') : '';
  return [
    `[OBJECTIVE]`,
    `Primary: ${o.primary}`,
    `Success: ${o.successCondition}`,
    fail ? `Fail modes: ${fail}` : null,
    `Improvise from player state. Do not steer back to a script.`
  ].filter(Boolean).join('\n');
}

function renderSettingAndTone(bundle) {
  if (!bundle?.settingAndTone) return null;
  return `[SETTING & TONE]\n${bundle.settingAndTone.trim()}`;
}

function renderWorldBible(bundle) {
  const wb = bundle?.worldBible;
  if (!wb || typeof wb !== 'object') return null;
  const lines = [`[WORLD BIBLE]`];
  for (const [k, v] of Object.entries(wb)) {
    if (typeof v === 'string' && v.trim()) {
      lines.push(`${labelize(k)}:\n${v.trim()}`);
    }
  }
  return lines.length > 1 ? lines.join('\n\n') : null;
}

function renderWorldConstraints(bundle) {
  if (!bundle?.worldConstraints) return null;
  return `[WORLD CONSTRAINTS]\n${bundle.worldConstraints.trim()}`;
}

function renderAdaptationRules(bundle) {
  if (!bundle?.adaptationRules) return null;
  return `[ADAPTATION RULES]\n${bundle.adaptationRules.trim()}`;
}

function renderCharacterRoster(bundle) {
  const chars = bundle?.characters || [];
  if (chars.length === 0) return null;
  const lines = [
    `[CHARACTER ROSTER]`,
    `Any of these may or may not appear in a given beat. Deploy them as the player's choices invite them in.`
  ];
  for (const c of chars) {
    lines.push(`  - ${c.id} (${c.name}${c.role ? ', ' + c.role : ''})`);
  }
  return lines.join('\n');
}

// ============================================================
// User-section renderers
// ============================================================

function renderInSceneBibles(inScene) {
  const ids = Object.keys(inScene || {});
  if (ids.length === 0) {
    return `[CHARACTER BIBLES - IN SCENE]\n(no persistent NPCs in scene)`;
  }
  const lines = [`[CHARACTER BIBLES - IN SCENE]`];
  for (const id of ids) {
    const npc = inScene[id];
    lines.push(`${id} - ${npc.name}${npc.role ? ' (' + npc.role + ')' : ''}`);
    lines.push(`  Location: ${npc.location ?? '(unknown)'}`);
    lines.push(`  Status:   ${npc.status ?? '(unknown)'}`);
    if (npc.motivationDelta) lines.push(`  Mood shift: ${npc.motivationDelta}`);
    if (Array.isArray(npc.currentKnowledge) && npc.currentKnowledge.length > 0) {
      lines.push(`  Knows:`);
      for (const k of npc.currentKnowledge) {
        lines.push(`    - "${k.fact}" (${k.confidence}, source: ${k.source})`);
      }
    }
    if (npc.notes) lines.push(`  Authoring notes: ${npc.notes}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderOffScreenNpcs(offScreen) {
  const ids = Object.keys(offScreen || {});
  if (ids.length === 0) return null;
  const lines = [
    `[OFF-SCREEN NPCS]`,
    `These NPCs exist but are not in the current scene. Their knowledge is intentionally hidden from you (knowledge isolation rule). Reason about them only through their last-known location/status.`
  ];
  for (const id of ids) {
    const npc = offScreen[id];
    lines.push(`  - ${id} (${npc.name}${npc.role ? ', ' + npc.role : ''}): last at "${npc.lastKnownLocation ?? '?'}", status "${npc.lastKnownStatus ?? '?'}"`);
  }
  return lines.join('\n');
}

function renderCurrentState(leanState) {
  const lines = [`[CURRENT STATE]`];
  lines.push(`  Hours on clock: ${leanState.clockHours ?? '?'}`);
  lines.push(`  Condition:      ${leanState.condition ?? '?'}`);
  lines.push(`  Location:       ${leanState.location ?? '?'}`);
  if (Array.isArray(leanState.assets) && leanState.assets.length > 0) {
    lines.push(`  Carrying:       ${leanState.assets.join(', ')}`);
  } else {
    lines.push(`  Carrying:       (nothing)`);
  }
  if (leanState.lastChoiceRisk) {
    lines.push(`  Last choice tier: ${leanState.lastChoiceRisk}`);
  }
  return lines.join('\n');
}

function renderWorldState(worldState) {
  if (!worldState || typeof worldState !== 'object') return null;
  const lines = [`[WORLD STATE]`];
  for (const [k, v] of Object.entries(worldState)) {
    if (k === 'majorEvents') continue;
    lines.push(`  ${labelize(k)}: ${v}`);
  }
  if (Array.isArray(worldState.majorEvents) && worldState.majorEvents.length > 0) {
    lines.push(`  Major events so far:`);
    for (const e of worldState.majorEvents) {
      lines.push(`    - ${e}`);
    }
  }
  return lines.join('\n');
}

function renderKnownThreats(knownThreats) {
  if (!Array.isArray(knownThreats) || knownThreats.length === 0) return null;
  const lines = [
    `[KNOWN THREATS]`,
    `These are persistent threats the player has learned about. Phase labels are qualitative. Do not invent numeric progress; the engine owns it.`
  ];
  for (const t of knownThreats) {
    const flags = [];
    if (t.completed) flags.push('completed');
    if (t.isVisibleInHud) flags.push('visible in HUD');
    else if (!t.completed) flags.push('hidden - slowed past 0');
    lines.push(`  - ${t.displayName} (${t.id}): phase "${t.currentPhase ?? '?'}" [${flags.join(', ')}]`);
  }
  return lines.join('\n');
}

function renderLivingWorld(recentRevelations, hudChanges) {
  const lines = [];
  if (Array.isArray(recentRevelations) && recentRevelations.length > 0) {
    lines.push(`[LIVING WORLD - weave these in this beat]`);
    for (const r of recentRevelations) {
      lines.push(`  - (${r.strength}, surfaced hour ${r.atHour}) ${r.summary}`);
    }
  }
  if (Array.isArray(hudChanges) && hudChanges.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`[HUD CHANGES - acknowledge briefly in prose if natural]`);
    for (const c of hudChanges) {
      const note = c.change === 'hidden'
        ? 'pushed out of immediate view (player slowed it past 0)'
        : c.change === 'resurgent'
          ? 'returning into view (progress caught up to slowdown)'
          : c.change;
      lines.push(`  - ${c.threatId}: ${note}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

function renderInvestigated(investigatedFacts, rumors) {
  const lines = [];
  if (Array.isArray(investigatedFacts) && investigatedFacts.length > 0) {
    lines.push(`[PLAYER HAS INVESTIGATED]`);
    for (const f of investigatedFacts) lines.push(`  - ${f}`);
  }
  if (Array.isArray(rumors) && rumors.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`[RUMORS - partial / unreliable]`);
    for (const r of rumors) {
      lines.push(`  - "${r.fact}" (${r.confidence}, from ${r.source}, hour ${r.atHour})`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

function renderRecentHistory(recentHistory) {
  if (!Array.isArray(recentHistory) || recentHistory.length === 0) return null;
  const lines = [`[RECENT HISTORY - prose only, for tonal continuity]`];
  for (const beat of recentHistory) {
    const title = beat?.title ? beat.title : '(untitled beat)';
    lines.push(`--- ${title} ---`);
    if (beat?.prose) lines.push(beat.prose.trim());
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderLastTurn(lastChoice) {
  if (!lastChoice) return null;
  const lines = [`[LAST TURN - what the player chose]`];
  lines.push(`Chosen: ${lastChoice.label ?? '?'} (risk: ${lastChoice.risk ?? '?'})`);
  lines.push(`  "${lastChoice.text ?? ''}"`);
  if (Array.isArray(lastChoice.otherChoices) && lastChoice.otherChoices.length > 0) {
    lines.push(`Rejected:`);
    for (const c of lastChoice.otherChoices) {
      lines.push(`  ${c.label ?? '?'} (risk: ${c.risk ?? '?'}) "${c.text ?? ''}"`);
    }
  }
  return lines.join('\n');
}

// ============================================================
// helpers
// ============================================================

function labelize(camelKey) {
  // 'cometStage' -> 'Comet stage'
  const spaced = String(camelKey).replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
