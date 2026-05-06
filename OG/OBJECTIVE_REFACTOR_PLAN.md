# Objective Refactor — Implementation Plan

**Status:** Draft, awaiting user review
**Scope:** Ember Crown world only. Architecture must generalize to future worlds without redesign.
**Goal:** Replace scripted-beat narrative with objective-driven open improvisation. Add visible clock, move budget, multi-axis state, risk-gated lethality.

---

## 1. Design Contract

### 1.1 Player-facing premise
- King Aldric is dying. You must reach his bedside before he does — or Halric crowns a puppet.
- You have **15 moves** and **96 in-fiction hours** to do it.
- Every choice changes some combination of distance, clock, condition, heat, or assets.
- The game ends one of five ways:
  1. **Reached the king** — `distanceToKing ≤ 5` (multiple ending shapes based on accumulated mood/state)
  2. **Clock expired** — `clockHours ≤ 0`
  3. **Moves exhausted** — `movesRemaining ≤ 0`
  4. **Killed / Trapped / Jailed** — only via a `desperate`-tagged choice resolving to failure

### 1.2 Runtime state shape (new)

```js
{
  gameId, worldName,
  turnNumber: int,                  // replaces beatNumber
  lastAppliedLogTurn: int,

  // Objective state (the new core)
  distanceToKing: int (0..100),     // 100 at start
  clockHours: int (0..96),          // 96 at start
  movesRemaining: int (0..15),      // 15 at start

  // Player state
  condition: 'healthy' | 'tired' | 'wounded' | 'exhausted' | 'dying',
  heat: int (0..4),                 // how hunted
  location: string,                 // freeform
  assets: string[],                 // 'horse', 'ally:sera', 'temple-shelter', etc.
  knowledgeFacts: string[],

  // Mood accumulators (for ending shape)
  selfOtherSum: float,              // sum across run; sign-of-average shapes ending
  assertYieldSum: float,

  // Last choice memo (for lethality gate)
  lastChoiceRisk: 'controlled' | 'risky' | 'desperate' | null,

  // World coloring (kept for prose flavor)
  worldState: { timeOfDay, cometStage },

  terminalState: null | { kind, summary },
  plotTrajectory: { majorEvents: string[], lastDirectorReasoning: string|null }
}
```

### 1.3 Model output contract (new)

```js
{
  worldImpacts: {
    stateChanges: {
      distanceDelta: int,                  // [-20, +5]
      clockHoursDelta: int,                // [-24, 0]
      movesDelta: int,                     // -1 (or 0 on terminal)
      conditionChange: <enum> | null,
      heatDelta: int,                      // [-1, +2]
      assetsAdded: string[],
      assetsRemoved: string[],
      knowledgeAdded: string[],
      worldStateDeltas: { timeOfDay?, cometStage? }
    },
    majorEventLogged: string
  },

  npcImpacts: [...],                       // unchanged structure

  narrativeResponse: {
    resolutionProse: string,               // narrates outcome of player's last choice
    isEnding: boolean,
    terminalState: null | { kind: <enum>, summary: string },

    nextBeat: null | {                     // null when terminal
      title: string,                       // freeform; no roman numerals
      intro: string,
      choices: [                           // 2..4 choices (was forced 3)
        {
          label: 'A'|'B'|'C'|'D',
          text: string,
          risk: 'controlled' | 'risky' | 'desperate',
          stake: string,                   // 1-clause "what's at risk"
          predictedDistanceDelta: int,
          predictedClockHours: int,        // hours this option would cost (positive)
          selfOther: float,                // 2x2 mood retained
          assertYield: float
        }
      ]
    }
  },

  forwardProjection: { tonalAim, currentConfidence },  // simplified
  directorReasoning: string
}
```

### 1.4 Validator rules (delta from existing)

- `distanceDelta` clamped `[-20, +5]`
- `clockHoursDelta` clamped `[-24, 0]`; cannot be positive
- `movesDelta` must be `-1` or `0` (0 only when terminal)
- `heatDelta` clamped `[-1, +2]`
- `nextBeat.choices.length ∈ [2, 4]` (was strict 3)
- Distinct-quadrant requirement **dropped** (was for 3 choices)
- `assets.length` capped at 12 (oldest dropped on overflow)
- **Lethality gate (critical):**
  `terminalState.kind ∈ {killed, trapped, jailed}` is only legal when `state.lastChoiceRisk === 'desperate'`. Validator rejects otherwise.
- `terminalState.kind === 'reached-king'` only legal when `distanceToKing ≤ 5` after deltas applied.
- `terminalState.kind ∈ {time-up, moves-up}` only legal when respective counter hits 0 after deltas (server can also force these).
- Server-owned fields (model cannot set directly): `distanceToKing`, `clockHours`, `movesRemaining`, `turnNumber`, `selfOtherSum`, `assertYieldSum`, `lastChoiceRisk`. Stripped silently if present.

### 1.5 Prompt composer — changes

**Remove**:
- Pacing budget (`targetBeatCount`, `climaxByBeat`, `tokensPerBeat`)
- Intensity curve (7-phase Aristotelian shape)
- Any forced beat-sequence scaffolding

**Keep**:
- Voice, setting, tone
- World bible (geography, magic rules, factions, recent history, current crisis, themes)
- World constraints
- Adaptation rules
- Character roster — annotated with **"any of these may or may not appear; deploy them as the player's choices invite them in"**
- Recent prose context window

**Add**:
- **Objective directive (top of prompt):** "The player must reach dying King Aldric. The game ends when they arrive, when the clock runs out, when their moves run out, or when they die/are trapped/jailed. Improvise from player state. Do not steer back to a script."
- **Current state block:** distance / clockHours / movesRemaining / condition / heat / location / assets / recent facts
- **Last turn:** chosen option text + its declared `risk` + the player's other (rejected) options
- **Lethality budget:** "Use desperate-tier outcomes sparingly. Death/trap/jail require that the player chose a `desperate` option AND failed. If they chose `controlled` or `risky`, narrate consequence-with-cost, never termination."
- **Ending trigger:** "If `distanceToKing ≤ 5` after applying your deltas, set `terminalState.kind = 'reached-king'` and write the bedside scene. The mood of that scene is shaped by the player's accumulated choices, not by your script."

---

## 2. World Bundle Changes (`worlds/ember-crown/world.json`)

**Remove**:
- `pacingBudget`
- `structuralObjective.climaxByBeat`
- `openingBeat.choices` and the prescribed prose

**Keep**:
- `worldName`, `displayName`, `tagline`, `voice`, `settingAndTone`
- `worldBible.*` (all)
- `worldConstraints`, `adaptationRules`
- `characters[]` (full roster)
- `playerStartingState`

**Add**:
```json
"objective": {
  "primary": "Reach the dying King Aldric.",
  "failModes": ["clock runs out", "moves run out", "killed", "trapped", "jailed"],
  "successCondition": "Stand at his bedside before he dies."
},
"startingClocks": {
  "distanceToKing": 100,
  "clockHours": 96,
  "movesRemaining": 15
},
"openingScene": {
  "location": "Wren's Hollow, dawn",
  "prose": "<existing opening prose, kept>",
  "choices": [
    {"label":"A","text":"Open the door before she can knock.","risk":"controlled","stake":"Commit to whatever she came to say.","predictedDistanceDelta":-2,"predictedClockHours":1,"selfOther":0.4,"assertYield":0.4},
    {"label":"B","text":"Stay silent. Do not answer.","risk":"risky","stake":"She may search the village or ride on without you.","predictedDistanceDelta":0,"predictedClockHours":2,"selfOther":-0.4,"assertYield":0.5},
    {"label":"C","text":"Slip out the back, into the woods.","risk":"risky","stake":"You go alone, blind to what she knew.","predictedDistanceDelta":-1,"predictedClockHours":3,"selfOther":-0.6,"assertYield":-0.4}
  ]
}
```

`xlsx-to-bundle.mjs` updates: drop `pacingBudget`/`openingBeat` mappings; add `objective`/`startingClocks`/`openingScene` mappings.

---

## 3. Server Flow Changes (`server/server.js`)

### 3.1 Turn-1 (opening)
- Seed runtime state from `world.startingClocks` and `world.playerStartingState`
- Render `openingScene` directly (no model call); emit `final`

### 3.2 Turn-2+ (every subsequent turn)
1. **Apply previous choice's deltas to state.** Authoritative server-side mutation:
   - Decrement `clockHours` by the chosen option's `predictedClockHours` (final, model can't override)
   - Decrement `movesRemaining` by 1
   - Apply `distanceDelta`, `heatDelta`, `condition` from `worldImpacts.stateChanges`
   - Append `assetsAdded` minus `assetsRemoved`
   - Update `selfOtherSum`, `assertYieldSum` from chosen option's coords
   - Set `lastChoiceRisk`
2. **Check forced terminals before model call:**
   - `clockHours ≤ 0` → emit `time-up` ending; skip model
   - `movesRemaining ≤ 0` → emit `moves-up` ending; skip model
3. **Compose prompt** from new state.
4. **Stream model** (existing SSE path).
5. **Validate.** On fail → 1 retry with `resume: sessionId` (existing).
6. **Apply model deltas** to a copy of state; check terminal predicates:
   - `distanceToKing ≤ 5` AND `terminalState.kind === 'reached-king'` → ending
   - `terminalState.kind ∈ {killed,trapped,jailed}` AND lastChoiceRisk was `desperate` → terminal
   - Otherwise non-terminal continuation
7. **Persist + emit `final`.**

### 3.3 New / changed endpoints
- `POST /turn/stream` — unchanged signature; new internals
- `GET /state?gameId=` — returns public state for browser refresh
- `POST /reset` — unchanged

---

## 4. Browser UI Changes (`index.html`)

### 4.1 Side panel widgets (new)
- **Clock face**: hours remaining, color-shifts red below 24
- **Moves counter**: "12 / 15 moves"
- **Distance bar**: "47 leagues to Vael's Reach"
- **Heat meter**: 0–4 pip indicator
- **Condition badge**: text chip with status color
- **Assets chip list**: comma-separated, including `ally:sera` style relationships

### 4.2 Choice rendering (changed)
- 2–4 buttons (not always 3)
- **Risk badge** per choice: green (controlled) / amber (risky) / red (desperate)
- **Stake clause** under choice text in italics
- **Cost preview**: "−8 leagues · −12h · 1 move"
- 2x2 quadrant tag retained but de-emphasized (small)

### 4.3 Terminal screens
- `reached-king` — bedside scene; ending-shape branch chosen by `selfOtherSum`/`assertYieldSum` averages
- `time-up` — "Halric crowns his puppet. The era ends without you."
- `moves-up` — "You are still on the road when the bells toll for the king."
- `killed`/`trapped`/`jailed` — cutscene + "Begin Again"

---

## 5. Tests

### Existing test files — extend
- `test-validator.mjs`:
  - desperate-only lethality rule (positive + negative cases)
  - distance/clock/moves/heat clamp ranges
  - 2..4 choice count
  - server-owned fields stripped
- `test-phase4.mjs`: update fixtures to new schema; remove pacing-budget assertions

### New test files
- `test-state-engine.mjs`:
  - apply delta with clamps
  - terminal detection (5 cases)
  - lethality gate enforcement
- `test-prompt-composer.mjs` (extend if exists, else new):
  - beat sequence section absent
  - objective + state block present
  - lethality budget instruction present

---

## 6. Phased Rollout

| Phase | Deliverable                                                                           | Test gate                                          |
|-------|---------------------------------------------------------------------------------------|----------------------------------------------------|
| **A** | Schema spec files (`server/schemas/objective.{model-output,runtime-state}.json`)       | User signs off on contract                         |
| **B** | Validator updates per §1.4                                                            | `test-validator.mjs` green                         |
| **C** | World bundle migrated; `xlsx-to-bundle.mjs` updated                                   | Bundle loads + revalidates                         |
| **D** | Prompt composer rewrite per §1.5                                                       | Snapshot test of rendered prompt                   |
| **E** | State engine + delta applier + terminal detection                                     | `test-state-engine.mjs` green                      |
| **F** | Server `/turn/stream` rewired; `/state` added                                         | Manual smoke run reaches a terminal each path      |
| **G** | Browser UI per §4                                                                     | Visual playtest of all terminal screens            |
| **H** | Playtest pass — 5 runs covering each terminal; tune clamps & starting clocks         | Subjective: does it feel tense?                    |

---

## 7. Open Questions for User Review

1. **Both budgets, or one?** Current plan tracks `clockHours` AND `movesRemaining` (hours = fictional pacing, moves = decision-budget abstraction). Alternative: pick one. *My recommendation: both — they reinforce each other.*
2. **Heat granularity.** Plan uses 0–4. Want finer (0–10)? *My recommendation: 0–4 is sufficient for v1.*
3. **Assets include relationships?** `ally:sera`, `enemy:halric` style. *My recommendation: yes — relationships are first-class assets.*
4. **Ending shapes at the king's bedside.** Plan: 3–4 endings shaped by `selfOtherSum`/`assertYieldSum` quadrant. Alternative: single arrival scene, model improvises ending. *My recommendation: 3-4 templated end-shapes that AI fills in, prevents flat endings.*
5. **Re-prompt budget on validation fail.** Currently 1 retry. Keep? *My recommendation: keep at 1.*
6. **Choice-count distribution.** AI picks 2–4 — should we enforce a minimum-3 default? *My recommendation: let AI choose 2–4 freely; trust the model to use 2 only when context demands it.*

---

## 8. Out of Scope (v2+)

- Ad-hoc waypoint clocks (Halric outriders closing in, Temple shelter timer)
- Location nodes / map navigation
- Skill stats / dream-charge meta-resource
- Inventory verbs as conditional 4th choices
- Multiple worlds with different objective archetypes
- Persistent run history / cross-run unlocks

---

## 9. Risk Register

| Risk                                                     | Mitigation                                                              |
|----------------------------------------------------------|-------------------------------------------------------------------------|
| AI uses `desperate` outcomes too eagerly                 | Lethality budget instruction; tune via playtest H                       |
| AI declares unrealistic `predictedDistanceDelta`         | Server clamps to validator range; player sees real cost post-resolution |
| Open structure → bland generic medieval                  | Keep full world bible + character roster in every prompt                |
| Player feels arbitrary deaths                            | Lethality gate: only desperate-tier choices can terminate the run       |
| Clock vs moves feels redundant                           | Phase H tuning; can collapse to one if playtest shows it                |
| 15 moves too few / too many                              | Phase H tuning; world bundle controls starting values                   |
| Rounding errors in `selfOtherSum` shape ending poorly    | Sign-of-average is robust; quadrant assignment is coarse on purpose     |

---

## 10. Approval Checklist

- [ ] §1.2 runtime state shape acceptable
- [ ] §1.3 model output contract acceptable
- [ ] §1.4 validator rules acceptable (esp. lethality gate)
- [ ] §1.5 prompt composer changes acceptable
- [ ] §2 world bundle migration acceptable
- [ ] §3 server flow acceptable
- [ ] §4 browser UI acceptable
- [ ] §6 phased rollout order acceptable
- [ ] §7 open questions answered
