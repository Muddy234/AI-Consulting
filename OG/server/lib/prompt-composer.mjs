// Composes the staged-turn prompt sent to Claude.
// Pure: takes world bundle, runtime state, recent log entries, and the player's choice;
// returns a single prompt string. Context-scoping (the leak mitigation) lives here.

const NPC_INVENTION_RULES = `
NPC INVENTION RULES:
- You may name and use background NPCs in prose freely (a passing merchant, a kitchen mistress, a wounded soldier on the road). The world should feel populated.
- Background NPCs exist only in this beat's prose. They have no persistent state and you should not assume the player can return to them later.
- Persistent NPCs - anyone you record in npcImpacts[] - must reference an npcId from the character bibles above. Do not invent new persistent NPCs.
- If a background character becomes important, write them through the bundle NPCs' actions instead (e.g., Sera notices and remarks).
`.trim();

const KNOWLEDGE_ISOLATION_RULE = `
KNOWLEDGE ISOLATION:
- Each NPC speaks only from what they personally know. Do not have an NPC reference a fact unless it appears in their currentKnowledge above, or they could plausibly have observed it in this scene.
- Do not have NPCs reference the player's private dreams, internal thoughts, or off-screen knowledge unless the player has expressed it.
`.trim();

const FORWARD_PROJECTION_FRAMING = (text) => `
PRIOR FORWARD PROJECTION - for continuity only:
Last turn you projected: ${text}
This was a hypothesis. The player's most recent choice may have invalidated it.
Reassess freely. Do not steer toward this projection if the player has diverged.
`.trim();

const CLIMAX_REQUIRED_BLOCK = `
[CLIMAX REQUIRED]
This story has reached its pacing budget. The structural objective MUST resolve in this beat or the next. Stage the climax now.
`.trim();

const ENDING_REQUIRED_BLOCK = `
[ENDING REQUIRED - FINAL]
Generate an ending. The era ends in this beat regardless of player position. Set isEnding: true.
`.trim();

const CHOICE_VITALITY_RULES = `
CHOICE PATH VITALITY (creative kick):
Every choice path must feel alive. Adaptation rule 5 (honor the choice) does NOT
mean "write quiet prose where nothing happens." Whatever the player picked, the
resolution prose AND the next beat's intro MUST do at least TWO of the following:
  - Introduce a NEW concrete stake: a witness, a debt, a temptation, a discovery,
    a small theft, a wound, a ghost, an unexpected ally — something specific the
    player must reckon with.
  - Reveal what the player bought or lost by the path they took: a messenger's
    arrival, smoke on the horizon, a rumor in a tavern, a dream that leaks a
    pivotal fact, a bird carrying a sigil. The world keeps moving; show it
    moving.
  - Surface an off-screen NPC pursuing their own goal — observable through
    evidence, not narration (footprints, a left-behind letter, a passing rider,
    an overheard name, a child's account).
  - Plant a personal cost specific to the direction the player chose (a wolf in
    the woods, a debt to a hedge-witch, a child who saw the player's face, a
    wound that won't close).

FORBIDDEN failure modes:
  - "Limbo prose" — long travel/contemplation without stakes.
  - "Echo prose" — NPCs (or weather, or scenery) that reflect the player's mood
    but advance nothing.
  - "Punishment prose" — making any path tedious to herd the player elsewhere.
    This violates adaptation rule 5.
  - "Quiet path" — yielding or withdrawing does NOT mean "boring." Surprise the
    player. Reward the choice with something only that direction could produce.
`.trim();

const INTENSITY_PHASES = {
  1: {
    name: 'establishing pressure',
    intensity: 'low',
    guidance: 'Set the clock. Show the world breathing — small details, mundane texture — but plant the pressure that will compound. The player should feel the time pressure without yet feeling crushed by it. No major reversal. End on a quiet, specific image that hints at what is coming.'
  },
  2: {
    name: 'complication',
    intensity: 'medium',
    guidance: 'The first real friction lands. An obstacle, a conflicting demand, an NPC pushing back. Stakes start to feel personal. Raise the cost of the player\'s current course. Do not yet land a major blow — escalate the friction.'
  },
  3: {
    name: 'false peak',
    intensity: 'high-then-breath',
    guidance: 'Stage a partial victory OR partial defeat that LANDS — a real beat. Then exhale. End the beat in a moment of breath: regrouping, a quiet conversation, an NPC tending a wound, a fire crackling. The reader thinks the worst is past. It is not.'
  },
  4: {
    name: 'real complication',
    intensity: 'rising',
    guidance: 'The actual problem reveals itself. The thing the player thought they were solving was the surface. Disclose a deeper threat, a betrayal, a buried fact, a wider scope. The breath from beat 3 is over. No more rest beats.'
  },
  5: {
    name: 'crisis',
    intensity: 'highest pre-climax',
    guidance: 'Squeeze. The player is cornered, isolated, or forced into a choice that has no clean exit. Time is collapsing. NPCs are in jeopardy. The structural objective is in immediate reach AND in immediate danger. Pressure should feel almost unbearable.'
  },
  6: {
    name: 'climax',
    intensity: 'peak',
    guidance: 'The structural objective resolves in foreground prose. Stage the confrontation, the death, the coronation, the betrayal — whatever the climaxType demands. This is the loudest beat in the era. Commit to consequences; do not hedge. The player\'s choice this turn must register as definitive.'
  },
  7: {
    name: 'resolution',
    intensity: 'release',
    guidance: 'Falling action. The world reshapes around what just happened. Show aftermath in concrete, sensory terms — who survives, what changes, what the player carries forward. Quieter than the climax but heavy with consequence. If isEnding is true, end here.'
  }
};

/**
 * Maps a beat number to a phase 1-7, scaling middle phases to climaxByBeat budget.
 * Phase 6 = climaxByBeat (climax). Phase 7 = climaxByBeat + 1+ (resolution).
 * Phase 1 = beat 1. Phases 2-5 stretched across beats 2..climaxByBeat-1.
 */
function intensityPhaseForBeat(beat, climaxByBeat) {
  if (beat <= 1) return 1;
  if (beat >= climaxByBeat + 1) return 7;
  if (beat === climaxByBeat) return 6;
  const span = climaxByBeat - 2;            // beats 2..climaxByBeat-1 hold phases 2..5
  if (span <= 0) return Math.min(5, Math.max(2, beat));
  const idx = beat - 2;
  const ratio = span === 1 ? 0 : idx / (span - 1);
  return 2 + Math.round(ratio * 3);          // 2,3,4,5
}

function intensityCurveBlock(state, currentBeat, climaxByBeat) {
  const phaseCurrent = intensityPhaseForBeat(currentBeat, climaxByBeat);
  const phaseNext = intensityPhaseForBeat(currentBeat + 1, climaxByBeat);
  const cur = INTENSITY_PHASES[phaseCurrent];
  const nxt = INTENSITY_PHASES[phaseNext];

  const fullCurve = Object.entries(INTENSITY_PHASES)
    .map(([n, p]) => `  Phase ${n} - ${p.name} (${p.intensity})`)
    .join('\n');

  return [
    'BEAT INTENSITY TARGETS',
    `Story shape is rise-rise-rise-spike-fall-rise-climax-resolution. Do not write a flat ramp.`,
    `Climax target: beat ${climaxByBeat}.`,
    '',
    `RESOLUTION PROSE (resolves beat ${currentBeat}) - phase ${phaseCurrent}: ${cur.name} (${cur.intensity})`,
    `  Guidance: ${cur.guidance}`,
    '',
    `NEXT BEAT INTRO (opens beat ${currentBeat + 1}) - phase ${phaseNext}: ${nxt.name} (${nxt.intensity})`,
    `  Guidance: ${nxt.guidance}`,
    '',
    'Full curve for context:',
    fullCurve,
    '',
    'Hard rules:',
    '- Do NOT make every beat the same intensity. Variation is the engine.',
    '- Phase 3 (false peak) MUST land a real partial victory or partial defeat, then exhale.',
    '- Phase 4 must NOT feel like another beat 2 - the scope/scale must visibly widen.',
    '- Phase 6 (climax) is foreground; resolve the structural objective in prose, not as ambient evidence.',
    '- Phase 7 is quieter than phase 6, but consequence must remain heavy and concrete.'
  ].filter(Boolean).join('\n');
}

const COORDINATE_FRAMEWORK = `
CHOICE COORDINATE FRAMEWORK (2x2 matrix):
Every choice you offer is positioned on a 2x2 grid by two orthogonal axes:

  Axis 1 - selfOther : -1.0 (fully SELF-oriented) ... +1.0 (fully OTHER-oriented)
    SELF-oriented = the player's own survival, autonomy, secrets, ambition,
      privacy, comfort, possessions, power, or interior life are the locus
      of the action.
    OTHER-oriented = another person, a faction, a community, a place, or a
      cause outside the player is the locus of the action. The player is
      acting for, on behalf of, or against an outside concern.

  Axis 2 - assertYield : -1.0 (fully ASSERT) ... +1.0 (fully YIELD)
    ASSERT = the player imposes, takes, refuses, names, demands, attacks,
      forces, claims, or otherwise pushes their will outward into the
      situation.
    YIELD  = the player gives way, listens, accepts, withdraws, observes,
      tends, mourns, agrees, or otherwise lets the situation move through
      them without forcing it.

The four quadrants and their narrative purpose:

  CLAIM       (selfOther < 0, assertYield < 0)
    "Take what is mine."
    Self-asserting action. Seizing power, refusing demands, defending
    autonomy, escaping captivity, claiming a name or a throne, telling a
    secret only to gain leverage, breaking a hold to act on private will.
    Tone: hot, decisive, often confrontational. Magnitude scales the
    aggression: -0.3 = quiet refusal; -0.9 = open defiance / violence /
    seizure.

  WITHDRAW    (selfOther < 0, assertYield > 0)
    "Step back into myself."
    Self-yielding action. Retreating, hiding, going silent, mourning in
    private, conceding the field, choosing not to be seen, abandoning a
    role, letting the moment pass and slipping away. Tone: cool, interior,
    sometimes shame-tinged or grief-tinged. Magnitude scales the
    completeness of the withdrawal: +0.3 = a held tongue; +0.9 = full
    desertion or vanishing.

  CHAMPION    (selfOther > 0, assertYield < 0)
    "Stand for them."
    Other-asserting action. Defending another, attacking on someone's
    behalf, speaking truth for a faction, taking a wound for a friend,
    declaring loyalty out loud, intervening in a fight that isn't yours.
    Tone: forceful with a moral charge directed outward. Magnitude scales
    the cost the player accepts: -0.3 = a public word in someone's favor;
    -0.9 = a body between blade and stranger.

  WITNESS     (selfOther > 0, assertYield > 0)
    "Hold space for them."
    Other-yielding action. Listening, tending a wound, sitting vigil,
    accepting another's grief or anger without redirecting it, honoring
    a request, comforting, agreeing to bear a burden, saying yes to a
    cost on someone else's terms. Tone: tender, attentive, often
    quiet but never empty. Magnitude scales the weight accepted: +0.3 =
    a held hand; +0.9 = vowing to carry someone's secret to the grave.

NARRATIVE INTENSITY BY QUADRANT:
  CLAIM    -> kinetic, declarative prose. Verbs of taking, breaking, naming.
  WITHDRAW -> contraction, interiority. Sensory detail of distance, removal.
  CHAMPION -> outward force with stakes. Verbs of standing, striking, vowing.
  WITNESS  -> attention as event. The smallest gestures carry the weight.

The MAGNITUDE on each axis tells you HOW HARD to push that quadrant's tone.
A choice at (-0.2, -0.2) is a barely-CLAIM; a choice at (-0.9, -0.9) is a
maximal CLAIM. Same quadrant, very different prose temperature.
`.trim();

const CHOICE_GENERATION_RULES = `
CHOICE GENERATION RULES:
You generate three coordinates first, THEN write each choice from its coordinate.
The coordinate is the brief; the prose serves the coordinate, not the reverse.

COORDINATE CONSTRAINTS (hard requirements):
- Each choice has selfOther in [-1.0, +1.0] and assertYield in [-1.0, +1.0].
- Both values are multiples of 0.10 (e.g. -0.7, +0.3, -0.4, +1.0). No finer.
- (0.0, 0.0) is forbidden. A choice on neither axis is not a choice.
- The three coordinates must occupy at least TWO distinct quadrants. Three
  coordinates all in the same quadrant is a rejected output.
- Two choices may share a quadrant ONLY if they differ noticeably in
  magnitude on at least one axis (e.g. one is a soft CLAIM at (-0.3, -0.3),
  the other is a hard CLAIM at (-0.9, -0.7)).
- The coordinate is a TARGET for the prose. The choice text must clearly
  read as that quadrant at that magnitude.

CHOICE WRITING:
- Each choice text is one short imperative clause (5-14 words). No
  explanations, no parentheticals.
- Each choice must be actionable from the player's current location and
  condition.
- Do not telegraph outcomes ("flee - and survive"). State the action only.
- The choice does NOT need to push toward the structural climax. The
  framework already shapes intensity through the beat curve and the world's
  pacing budget; choices are about what the player does, not what the plot
  demands. Climax escalation is your job through the curve, not through
  steering choices.
`.trim();

// ----- context scoping -----

/**
 * Naive substring proximity match: NPC is "in scene" if either location contains the other.
 * Tuneable later; surface area documented in plan §13.
 */
export function isInScene(playerLocation, npcLocation) {
  if (!playerLocation || !npcLocation) return false;
  const p = String(playerLocation).toLowerCase();
  const n = String(npcLocation).toLowerCase();
  return p.includes(n) || n.includes(p);
}

/**
 * Splits npcStates into in-scene (full knowledge) and off-screen (name+role+location only) views.
 */
export function scopeNpcs(world, state) {
  const playerLoc = state.playerState?.location || '';
  const charactersById = new Map((world.characters || []).map(c => [c.id, c]));

  const inScene = [];
  const offScreen = [];

  for (const [id, npcState] of Object.entries(state.npcStates || {})) {
    const character = charactersById.get(id);
    const name = character?.name || id;
    const role = character?.role || '';
    const loc = npcState.location || character?.startingLocation || 'unknown';
    const status = npcState.status || character?.startingStatus || '';
    if (isInScene(playerLoc, loc)) {
      inScene.push({
        id, name, role,
        location: loc,
        status,
        motivationDelta: npcState.motivationDelta || null,
        currentKnowledge: Array.isArray(npcState.currentKnowledge) ? npcState.currentKnowledge : [],
        bible: character || null
      });
    } else {
      offScreen.push({
        id, name, role,
        lastKnownLocation: loc,
        lastKnownStatus: status
      });
    }
  }

  return { inScene, offScreen };
}

// ----- composition -----

function characterBibleBlock(character) {
  if (!character) return '';
  const lines = [
    `### ${character.name} (${character.id}) - ${character.role}`,
    character.physical && `Physical: ${character.physical}`,
    character.voice && `Voice: ${character.voice}`,
    character.motivations && `Motivations: ${character.motivations}`,
    character.allegiances && `Allegiances: ${character.allegiances}`,
    character.knowledgeText && `Authored knowledge: ${character.knowledgeText}`,
    character.notes && `Notes (authoring hint): ${character.notes}`
  ].filter(Boolean);
  return lines.join('\n');
}

function inSceneNpcBlock(npc) {
  const knowledge = npc.currentKnowledge.length === 0
    ? '  (no facts yet)'
    : npc.currentKnowledge.map(k =>
        `  - ${k.fact} [${k.confidence || 'certain'}, source: ${k.source || 'authored'}]`
      ).join('\n');
  return [
    `${npc.name} (${npc.id})`,
    `  location: ${npc.location}`,
    `  status: ${npc.status}`,
    npc.motivationDelta ? `  motivation: ${npc.motivationDelta}` : null,
    `  currentKnowledge:`,
    knowledge
  ].filter(Boolean).join('\n');
}

function offScreenNpcLine(npc) {
  return `${npc.name} (${npc.id}) - ${npc.role} - ${npc.lastKnownLocation} - ${npc.lastKnownStatus}`;
}

function recentHistoryBlock(world, recentTurnEntries) {
  const lines = [];
  // Opening beat always included.
  if (world.openingBeat) {
    lines.push(`## Opening beat: ${world.openingBeat.title}`);
    lines.push(world.openingBeat.prose || '');
  }
  for (const t of recentTurnEntries) {
    const prose = pickProse(t);
    lines.push(`## Beat ${t.beatNumber}${t.playerChoice ? ` (player chose ${t.playerChoice})` : ''}`);
    lines.push(prose || '(no prose recorded)');
  }
  return lines.join('\n\n');
}

function pickProse(turnEntry) {
  // turn entries store the full model output; extract the resolution + nextBeat.intro for history.
  const out = turnEntry.modelOutput;
  if (!out) return '';
  if (typeof out === 'string') return out;  // opening-beat synthetic entry
  const parts = [];
  if (out.narrativeResponse?.resolutionProse) parts.push(out.narrativeResponse.resolutionProse);
  if (out.narrativeResponse?.nextBeat?.intro) parts.push(out.narrativeResponse.nextBeat.intro);
  return parts.join('\n\n');
}

const OUTPUT_SCHEMA_REMINDER = `
OUTPUT SCHEMA (return exactly this JSON, no prose outside the object):
{
  "worldImpacts": {
    "stateChanges": {
      "timeElapsed": "<phrase like '6 hours' or 'the next morning' or null>",
      "worldStateDeltas": { "<allowed enum field>": "<allowed value>" }
    },
    "majorEventLogged": "<one sentence or null>"
  },
  "npcImpacts": [
    {
      "npcId": "<id from character bibles>",
      "locationDelta": "<string or null>",
      "statusDelta": "<string or null>",
      "motivationDelta": "<string or null>",
      "knowledgeGained": [{ "fact": "<...>", "confidence": "certain|suspected|rumored" }],
      "offScreenAction": "<string or null>"
    }
  ],
  "narrativeResponse": {
    "resolutionProse": "<80-120 words: the consequence of the player's choice>",
    "nextBeat": {
      "title": "<...>",
      "intro": "<150-200 words: the new beat opening>",
      "choices": [
        { "label": "A", "text": "<...>", "selfOther": <-1.0..+1.0>, "assertYield": <-1.0..+1.0> },
        { "label": "B", "text": "<...>", "selfOther": <-1.0..+1.0>, "assertYield": <-1.0..+1.0> },
        { "label": "C", "text": "<...>", "selfOther": <-1.0..+1.0>, "assertYield": <-1.0..+1.0> }
      ]
    },
    "isEnding": false
  },
  "forwardProjection": {
    "next2BeatsTarget": "<...>",
    "tonalAim": "<...>",
    "currentConfidence": "low|moderate|high"
  },
  "directorReasoning": "<short note: how the player's choice steered the path>"
}
- Exactly 3 choices, labels A/B/C.
- Each choice's selfOther and assertYield are numbers in [-1.0, +1.0] in 0.10 steps.
- (0.0, 0.0) is forbidden. The three choices must span at least 2 quadrants.
- Do NOT set worldDay, timeOfDay, or cumulativeHoursElapsed in worldStateDeltas - the server owns those.
`.trim();

/**
 * Composes the full prompt.
 * @param {object} args
 * @param {object} args.world - validated world bundle
 * @param {object} args.state - current runtime state
 * @param {Array}  args.recentTurnEntries - oldest-first, up to N from beat-log.tailTurnEntries
 * @param {string|null} args.playerChoice - 'A'|'B'|'C' or null on turn 1 (turn 1 is hardcoded)
 * @param {Array|null} [args.priorChoices] - the choice menu the player picked from (for letter -> text mapping)
 * @param {object} [args.opts] - { ending } where ending is true to inject ENDING_REQUIRED_BLOCK
 * @returns string
 */
export function composePrompt({ world, state, recentTurnEntries, playerChoice, priorChoices = null, opts = {} }) {
  const { inScene, offScreen } = scopeNpcs(world, state);
  const sections = [];

  sections.push(`# VOICE\n${world.voice || ''}`);
  sections.push(`# STRUCTURAL OBJECTIVE (thematic, not mechanical)\n` +
    `${world.structuralObjective?.thematic || ''}\n` +
    `Climax type: ${world.structuralObjective?.climaxType || 'unspecified'}`);
  sections.push(`# WORLD CONSTRAINTS\n${world.worldConstraints || ''}`);
  sections.push(`# ADAPTATION RULES\n${world.adaptationRules || ''}`);
  sections.push(`# ${NPC_INVENTION_RULES.split('\n')[0]}\n${NPC_INVENTION_RULES.split('\n').slice(1).join('\n')}`);

  // Character bibles only for in-scene NPCs.
  if (inScene.length > 0) {
    const bibles = inScene.map(n => characterBibleBlock(n.bible)).filter(Boolean).join('\n\n');
    sections.push(`# CHARACTER BIBLES (in-scene only)\n${bibles}`);
  }

  // Current state: visible fields only. Hide cumulativeHoursElapsed (internal) per plan §5.
  const visibleWorld = { ...state.worldState };
  delete visibleWorld.cumulativeHoursElapsed;

  sections.push(
    `# CURRENT STATE\n` +
    `Beat: ${state.beatNumber}\n` +
    `worldState: ${JSON.stringify(visibleWorld, null, 2)}\n` +
    `playerState: ${JSON.stringify(state.playerState, null, 2)}\n` +
    `plotTrajectory: ${JSON.stringify(state.plotTrajectory || {}, null, 2)}`
  );

  if (inScene.length > 0) {
    sections.push(`# IN-SCENE NPCS (with knowledge)\n` + inScene.map(inSceneNpcBlock).join('\n\n'));
  }
  if (offScreen.length > 0) {
    sections.push(`# OFF-SCREEN NPCS (no knowledge in scope)\n` + offScreen.map(offScreenNpcLine).join('\n'));
  }

  if (state.forwardProjection?.next2BeatsTarget) {
    sections.push(`# ${FORWARD_PROJECTION_FRAMING(state.forwardProjection.next2BeatsTarget)}`);
  }

  sections.push(`# RECENT HISTORY\n${recentHistoryBlock(world, recentTurnEntries)}`);

  sections.push(`# ${KNOWLEDGE_ISOLATION_RULE.split('\n')[0]}\n${KNOWLEDGE_ISOLATION_RULE.split('\n').slice(1).join('\n')}`);

  // Pacing escalation
  const climaxByBeat = world.pacingBudget?.climaxByBeat || 6;
  if (opts.ending) {
    sections.push(`# ${ENDING_REQUIRED_BLOCK}`);
  } else if (state.beatNumber >= climaxByBeat) {
    sections.push(`# ${CLIMAX_REQUIRED_BLOCK}`);
  }

  if (Array.isArray(priorChoices) && priorChoices.length > 0) {
    const menuLines = priorChoices.map(c => {
      const so = typeof c.selfOther === 'number' ? c.selfOther.toFixed(1) : '?';
      const ay = typeof c.assertYield === 'number' ? c.assertYield.toFixed(1) : '?';
      return `${c.label}: ${c.text}  [selfOther=${so}, assertYield=${ay}]`;
    }).join('\n');
    sections.push(`# CHOICE MENU OFFERED LAST BEAT (the player picked from this list)\n${menuLines}`);
  }

  sections.push(`# PLAYER'S MOST RECENT CHOICE\n${playerChoice ?? '(none - turn 1)'}`);

  sections.push(`# ${CHOICE_VITALITY_RULES.split('\n')[0]}\n${CHOICE_VITALITY_RULES.split('\n').slice(1).join('\n')}`);
  sections.push(`# ${COORDINATE_FRAMEWORK.split('\n')[0]}\n${COORDINATE_FRAMEWORK.split('\n').slice(1).join('\n')}`);
  sections.push(`# ${CHOICE_GENERATION_RULES.split('\n')[0]}\n${CHOICE_GENERATION_RULES.split('\n').slice(1).join('\n')}`);

  // Intensity curve targets for resolutionProse + nextBeat.intro
  const intensityBlock = intensityCurveBlock(state, state.beatNumber, climaxByBeat);
  sections.push(`# ${intensityBlock.split('\n')[0]}\n${intensityBlock.split('\n').slice(1).join('\n')}`);

  sections.push(`# ${OUTPUT_SCHEMA_REMINDER}`);

  return sections.join('\n\n---\n\n');
}

// Exported for testing only.
export const _internal = {
  CLIMAX_REQUIRED_BLOCK,
  ENDING_REQUIRED_BLOCK,
  NPC_INVENTION_RULES,
  KNOWLEDGE_ISOLATION_RULE,
  COORDINATE_FRAMEWORK,
  CHOICE_GENERATION_RULES,
  CHOICE_VITALITY_RULES,
  INTENSITY_PHASES,
  intensityPhaseForBeat,
  intensityCurveBlock
};
