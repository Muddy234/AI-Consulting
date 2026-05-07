# Objective Refactor — Implementation Plan (rev 2)

**Status:** Revised draft, decisions folded in; ready to build
**Scope:** Ember Crown world only. Architecture must generalize to future worlds without redesign.
**Goal:** Replace scripted-beat narrative with a living-world simulator under an objective-driven story. Single visible clock; earned-HUD threat meters; scheduled-event counterfactuals; hyperlinked prose for selective revelation.

### What changed from rev 1

Removed (made the game readable, not exciting):
- Pre-disclosed cost numbers per choice (`predictedDistanceDelta`, `predictedClockHours`)
- Stake clause and risk-badge UI (turned tension into spreadsheet play)
- `movesRemaining` budget (redundant with the hours clock)
- Generic 0–4 `heat` meter (replaced by named, earnable threat meters)
- 2x2 mood-quadrant choice metadata
- `selfOtherSum` / `assertYieldSum` hidden quadrant ending math
- HUD widgets for distance, heat, assets, moves

Added (the world is alive whether or not you're watching):
- Living-world simulator: `worldState` (always true, always ticked) vs. `playerKnowledge` (curated subset surfaced through prose / hyperlinks)
- Three-tier event taxonomy: macro-threat / scene-event / silent simulation
- Authored-tentpole + engine-generated scheduled events with preconditions (for counterfactuals — good and bad)
- Diegetic consequence revelation (delayed, indirect; player draws the causal chain)
- Earned-HUD threat meters (only render when player has learned of the threat; slide off when slowed past 0)
- Hyperlinked prose with typed links (lore / clue / flavor / threat-reveal / npc-detail / investigation); styled `***italic + bold***`; first-click idempotent; some cost in-fiction time
- Threat-slowing player actions (`desperate` choices can push back antagonist progress)
- Model-authored macro-threats at runtime (capped at 2 per game)
- Model-authored ending screens for all terminal states, including the silent-completion irony case

Retained from rev 1:
- 96-hour primary clock
- Lethality gate (with refinement: only *terminal* outcomes require `desperate`; non-lethal surprises allowed on controlled/risky)
- Risk tag on choices (engine-internal only; not styled in UI)
- `condition` chip; `assets` (including relationship-style entries like `ally:sera`)

---

## 1. Design Contract

### 1.1 Player-facing premise
- King Aldric is dying. You must reach his bedside before he does — or before Halric crowns a puppet.
- You have **96 in-fiction hours**.
- The world is alive: NPCs and factions act on their own plans whether or not you're watching. Your choices ripple — sometimes visibly, sometimes never seen.
- You see only what you've witnessed or investigated. Curiosity is rewarded; ignorance has costs.
- The game ends one of these ways:
  1. **Reached the king** — bedside scene; ending shape determined by which threats completed, which you stopped, and which you never learned about
  2. **Clock expired** — Halric crowns his puppet
  3. **Killed / Trapped / Jailed** — only via a `desperate`-tagged choice resolving to failure

### 1.2 Runtime state shape

```js
{
  gameId, worldName,
  turnNumber: int,
  lastAppliedLogTurn: int,

  // Single visible clock (engine-owned)
  clockHours: int (0..96),

  // Engine-internal; gates the "reached-king" ending; never rendered
  distanceToKing: int (0..100),

  // Player state
  condition: 'healthy' | 'tired' | 'wounded' | 'exhausted' | 'dying',
  location: string,
  assets: string[],                 // 'horse', 'ally:sera', 'temple-shelter', etc.; cap 12

  // Last choice memo (lethality gate input)
  lastChoiceRisk: 'controlled' | 'risky' | 'desperate' | null,

  // World simulation (always true, always ticked)
  worldState: {
    timeOfDay: string,
    cometStage: string,
    kingStatus: <enum>,
    crownStatus: <enum>,
    antagonistPower: <enum>,
    majorEvents: string[]           // rolling, cap 12
  },

  // Macro-threats (persistent, may surface as HUD meters when known)
  threats: {
    [threatId]: {
      progress: int,                 // hours; engine-owned; ticks every turn
      currentPhase: string,          // computed from progress against bundle phases
      slowedBy: int,                 // accumulated player-induced slowdown
      knownToPlayer: boolean,        // gates HUD render
      revealedAtHour: int | null,
      completed: boolean,
      completedAt: int | null
    }
  },

  // Scheduled events (one-shot pending world events)
  scheduledEvents: [
    {
      id: string,
      fireAtHour: int,               // absolute, in-fiction hours from start
      preconditions: [...],
      outcomeOnFire: { ... },
      outcomeOnCancel: { ... } | null,
      status: 'pending' | 'fired' | 'cancelled',
      authorSource: 'authored' | 'model'
    }
  ],

  // Player knowledge layer (curated subset surfaced through prose/hyperlinks)
  playerKnowledge: {
    knownThreatIds: string[],        // gates threat HUD rendering
    witnessedEvents: [               // for prompt composer "what player saw"
      { eventId, atHour, strength, summary }
    ],
    rumors: [                        // partial / unreliable
      { fact, source, atHour, confidence }
    ],
    investigatedFacts: string[]      // unlocked via hyperlink clicks
  },

  // NPC state (knowledge-scoped; carried over from rev 1 architecture)
  npcStates: { ... },

  // Run accumulator (shapes ending; replaces hidden quadrant math)
  runHistory: {
    threatsCompleted: string[],
    threatsStopped: string[],
    threatsNeverLearned: string[],
    counterfactualsFiredKnown: string[],
    counterfactualsFiredSilent: string[]
  },

  terminalState: null | { kind, summary }
}
```

### 1.3 Model output contract

```js
{
  worldImpacts: {
    stateChanges: {
      clockHoursDelta: int,          // positive; server subtracts from clockHours
      distanceDelta: int,            // engine-internal, no UI
      conditionChange: <enum> | null,
      assetsAdded: string[],
      assetsRemoved: string[],
      worldStateDeltas: { ... }
    },
    majorEventLogged: string,

    // Threat slowdowns from this turn's player action
    threatSlowdowns: [
      { threatId, hours, reason }
    ],

    // Model-authored scheduled events (engine-generated layer)
    scheduledEventsToAdd: [
      {
        id: string,
        fireAtHour: int,
        preconditions: [...],
        outcomeOnFire: {
          worldStateDelta: {...},
          npcImpacts: [...],
          revelation: {
            strength: 'loud' | 'quiet' | 'ambient' | 'silent',
            delayHours: int,
            content: string
          }
        },
        outcomeOnCancel: { revelation: {...} | null } | null
      }
    ],

    // Model-authored macro-threats (use sparingly — see §1.5)
    macroThreatsToAdd: [
      {
        id: string,
        displayName: string,
        icon: string,
        duration: int,
        phases: [...],
        unlockConditions: [...],
        interactions: [...],
        onComplete: { ... }
      }
    ]
  },

  npcImpacts: [...],                  // unchanged structure

  narrativeResponse: {
    // Resolution prose for the just-resolved player choice
    resolutionProse: {
      segments: [
        { type: 'text', content: string },
        { type: 'link', id: string, content: string,
          linkType: 'lore'|'clue'|'flavor'|'threat-reveal'|'npc-detail'|'investigation' }
      ]
    },
    resolutionLinkContents: {
      [linkId]: {
        content: string,                // 20–50 words
        costHours: int,                 // default 0
        unlocksFacts: string[],
        unlocksThreats: string[]        // threat ids that become knownToPlayer on click
      }
    },

    isEnding: boolean,
    terminalState: null | { kind: <enum>, summary },

    nextBeat: null | {
      title: string,
      intro: { segments: [...] },
      introLinkContents: { ... },
      choices: [
        {
          label: 'A'|'B'|'C'|'D',
          text: string,
          risk: 'controlled' | 'risky' | 'desperate'   // INTERNAL; not styled in UI
        }
      ]                                  // 2..4 entries
    }
  },

  forwardProjection: { tonalAim, currentConfidence },
  directorReasoning: string
}
```

### 1.4 Validator rules

- `clockHoursDelta ∈ [0, 24]`; positive (server subtracts)
- `distanceDelta ∈ [-20, +5]`
- `nextBeat.choices.length ∈ [2, 4]`
- `assets` length capped at 12 (oldest dropped on overflow)
- **Lethality gate (terminal-only):**
  - `terminalState.kind ∈ {killed, trapped, jailed}` is legal **only** when `state.lastChoiceRisk === 'desperate'`. Validator rejects otherwise.
  - Non-lethal "surprise" consequences (heat-equivalent state changes, asset loss, NPC mood flips) are *legal* on `controlled` and `risky` choices. Safe ≠ predictable.
  - `terminalState.kind === 'reached-king'` legal only when `distanceToKing ≤ 5` after deltas applied.
  - `terminalState.kind === 'time-up'` legal only when `clockHours ≤ 0` after deltas (server may also force this).
- **Server-owned (silently stripped if model sets):** `clockHours`, `distanceToKing`, `turnNumber`, every `threats[*].progress` / `knownToPlayer` / `completed` field, every `scheduledEvents[*].status`.
- **Hyperlink rules:**
  - Each `linkId` unique within a beat
  - `linkType` ∈ {`lore`, `clue`, `flavor`, `threat-reveal`, `npc-detail`, `investigation`}
  - `unlocksThreats` must reference threat ids defined in the world bundle
  - `costHours ∈ [0, 6]`
  - Beat is rejected if a link in `segments` has no matching entry in `linkContents`
- **Scheduled event rules:**
  - `fireAtHour > cumulativeHoursElapsed` (no past-scheduling)
  - `revelation.strength` ∈ enum above
  - `revelation.delayHours ∈ [0, 48]`
- **Model-authored macro-threats:**
  - `id` must not collide with existing threat ids
  - `duration ∈ [12, 96]`
  - `phases.length ∈ [1, 5]`
  - `authorSource` recorded as `'model'` for analytics
  - Hard cap: **2 model-authored macro-threats per game** (prevents threat-spam; bundle threats are unlimited)
- **Risk tag is internal.** Validator confirms its presence and enum membership but the UI layer is forbidden from styling it as a colored badge.

### 1.5 Prompt composer

**Read from `playerKnowledge`, never from `worldState` directly.** The model literally cannot leak silent simulation because it never sees it. This extends the rev-1 NPC-knowledge-scoping principle to the world itself.

**Remove:**
- Pacing budget (`targetBeatCount`, `climaxByBeat`, `tokensPerBeat`)
- Aristotelian intensity curve / forced beat-sequence scaffolding
- Predicted-delta authoring instruction
- 2x2 quadrant authoring instruction
- Stake-clause authoring instruction
- Risk-badge UI rendering instruction

**Keep:**
- Voice, setting, tone
- World bible (geography, magic, factions, history, current crisis, themes)
- World constraints
- Adaptation rules
- Character roster — annotated "any of these may or may not appear; deploy them as the player's choices invite them in"
- Recent prose context window (opening + last 3)
- NPC knowledge scoping (in-scene full; off-screen no knowledge field)

**Add:**
- **Objective directive (top of prompt):** "The player must reach dying King Aldric. The game ends when they arrive, when the clock runs out, or when they die/are trapped/jailed. Improvise from player state. Do not steer back to a script."
- **Current state block (lean):** clockHours, condition, location, recent assets/facts, known threats with current phase
- **Last turn:** chosen option text + its declared `risk` + the player's other (rejected) options
- **Lethality budget:** "Death/trap/jail require that the player chose `desperate` AND failed. On `controlled` or `risky`, you may surprise the player with non-lethal consequences (a stolen horse, a poisoned wound, an ally's trust shaken) — but never with termination."
- **Living-world block:** lists due-revelations queued by the engine for this beat (loud/quiet/ambient) with instruction to weave them into prose at the marked strength.
- **Hyperlink authoring instruction:** "Author 0–6 hyperlinks per beat. Tag each by linkType. Most should be `flavor` or `lore` (atmospheric, harmless). Use `clue` sparingly; reserve `threat-reveal` for when the player is brushing against a hidden threat. Costly investigations (hours > 0) should feel like deliberate effort, not casual reading."
- **Counterfactual restraint:** "If you author scheduled events at runtime, default revelation strength is `quiet`, default delay is 12–24 hours. Reserve `loud` for events the player will likely encounter directly. Reserve `silent` for cancelled outcomes (the saved-without-knowing case)."
- **Macro-threat authoring (use sparingly):** "You may promote a major emergent situation into a persistent threat via `macroThreatsToAdd` — a faction whose plan you've just exposed; an ally turned hunter; a betrayal whose consequences will tick across many beats. Reserve this for genuine mid-run pivots, not re-skins of existing threats. Capped at 2 per game; the validator will reject a third."
- **Ending trigger:** "If `distanceToKing ≤ 5` after applying your deltas, set `terminalState.kind = 'reached-king'`. The mood of the bedside scene is shaped by `runHistory` (which threats you completed/stopped/never-learned), not by your script."

---

## 2. World Bundle Changes (`worlds/ember-crown/world.json`)

**Remove:**
- `pacingBudget`
- `structuralObjective.climaxByBeat`
- `openingBeat.choices` with predicted deltas

**Keep:**
- `worldName`, `displayName`, `tagline`, `voice`, `settingAndTone`
- `worldBible.*` (all)
- `worldConstraints`, `adaptationRules`
- `characters[]` (full roster, retaining `notes`/`baselineKnowledge`)
- `playerStartingState`

**Add:**

```json
"objective": {
  "primary": "Reach the dying King Aldric.",
  "failModes": ["clock runs out", "killed", "trapped", "jailed"],
  "successCondition": "Stand at his bedside before he dies."
},

"startingClocks": {
  "clockHours": 96,
  "distanceToKing": 100
},

"threats": [
  {
    "id": "halric-coronation",
    "displayName": "Halric's Plan",
    "icon": "crown-broken",
    "duration": 96,
    "phases": [
      { "atProgress": 0,  "label": "Brewing" },
      { "atProgress": 40, "label": "Moving" },
      { "atProgress": 75, "label": "Imminent" }
    ],
    "unlockConditions": [
      { "type": "playerKnowsFact", "fact": "halric-plotting-coronation" }
    ],
    "interactions": [
      { "trigger": "messenger-intercepted", "effect": "slow", "amount": 12 }
    ],
    "onComplete": {
      "worldStateDelta": { "antagonistPower": "king" },
      "majorEvent": "Halric crowned his puppet."
    }
  }
],

"authoredScheduledEvents": [
  {
    "id": "kings-decline-hour-48",
    "fireAtHour": 48,
    "preconditions": [],
    "outcomeOnFire": {
      "worldStateDelta": { "kingStatus": "near-death" },
      "revelation": {
        "strength": "loud",
        "delayHours": 0,
        "content": "Bells toll in distant towers."
      }
    },
    "outcomeOnCancel": null
  }
],

"openingScene": {
  "location": "Wren's Hollow, dawn",
  "prose": { "segments": [ /* structured with hyperlinks */ ] },
  "linkContents": { /* matching link ids */ },
  "choices": [
    { "label": "A", "text": "Open the door before she can knock.",   "risk": "controlled" },
    { "label": "B", "text": "Stay silent. Do not answer.",           "risk": "risky" },
    { "label": "C", "text": "Slip out the back, into the woods.",    "risk": "risky" }
  ]
}
```

`xlsx-to-bundle.mjs` updates:
- Drop `pacingBudget` / `openingBeat` mappings
- Add `objective` / `startingClocks` / `threats[]` / `authoredScheduledEvents[]` / `openingScene` mappings
- New xlsx sheets: `Threats`, `ScheduledEvents`, `OpeningScene` (with link rows)

Tentpole event count for Ember Crown v1: **5–8 authored scheduled events** (king's decline thresholds, Halric phase-shifts, comet zenith, etc.) plus the macro-threat. Final count is open question §7.

---

## 3. Server Flow Changes (`server/server.js`)

### 3.1 Turn-1 (opening)
- Seed runtime state from `world.startingClocks`, `world.playerStartingState`, `world.threats`, `world.authoredScheduledEvents`.
- All threats start `progress: 0, knownToPlayer: false`.
- Render `openingScene` directly (no model call); seed log with synthetic turn-1 entry.

### 3.2 Turn-2+ (every subsequent turn)

1. **Apply previous choice's deltas authoritatively.**
   - `clockHours -= clockHoursDelta`
   - `distanceToKing += distanceDelta` (clamped)
   - Apply `condition`, `assetsAdded`/`assetsRemoved`, `worldStateDeltas`
   - Set `lastChoiceRisk` from the chosen option

2. **World tick (engine-owned, runs regardless of player visibility):**
   - For each `threats[*]`: `progress += clockHoursDelta - applicableSlowdown`. Recompute `currentPhase`. If `progress ≥ duration`, mark completed and queue its `onComplete` payload.
   - For each `scheduledEvents[*]` with `status === 'pending'` and `fireAtHour ≤ cumulativeHoursElapsed`:
     - Evaluate preconditions
     - Mark `fired` or `cancelled`
     - Apply `outcomeOnFire.worldStateDelta` / `npcImpacts` (or `outcomeOnCancel`)
     - Enqueue the event's `revelation` into the revelation queue (with delay)
   - Process due revelations: any with `revealAtHour ≤ cumulativeHoursElapsed` are moved into `playerKnowledge.witnessedEvents` and flagged for the prompt composer to weave into next prose.

3. **Check forced terminals before model call:**
   - `clockHours ≤ 0` → emit `time-up` ending; skip standard model call (ending screen still uses a separate model call — see §4.4)
   - Any threat with a forced-end `onComplete` (e.g., `halric-coronation`) completed → emit forced-end. Fires regardless of whether the threat was `knownToPlayer` — the ironic ending is part of the design (see §4.4).

4. **Compose prompt** from `playerKnowledge` and lean state block (see §1.5). Include due-revelations.

5. **Stream model** (existing SSE path).

6. **Validate.** On fail → 1 retry with `resume: sessionId`.

7. **Apply model deltas** to a copy of state. Write-ahead log entry.

8. **Process model-authored `scheduledEventsToAdd`:** validate, add to `scheduledEvents[]` with `authorSource: 'model'`.

9. **Process model-authored `macroThreatsToAdd`:** validate (cap of 2 per game enforced), add to `threats{}` with `authorSource: 'model'`, `progress: 0`, `knownToPlayer: false`. Unlock conditions evaluate on next turn like any threat.

10. **Process `threatSlowdowns`:** apply to corresponding threats' `slowedBy`. If a known threat's `effectiveProgress = max(0, progress - slowedBy)` drops to 0, mark for HUD removal in this turn's response. The threat object stays in state with `knownToPlayer: true`; if later progress exceeds `slowedBy` again, the meter reappears and the prompt composer flags this as a beat-level event the model may acknowledge in prose.

11. **Check terminal predicates after model deltas:**
    - `distanceToKing ≤ 5` AND `terminalState.kind === 'reached-king'` → ending
    - `terminalState.kind ∈ {killed, trapped, jailed}` AND `lastChoiceRisk === 'desperate'` → terminal
    - Otherwise continue

12. **Persist + emit `final`.**

### 3.3 New / changed endpoints

- `POST /turn/stream` — unchanged signature; new internals
- `POST /investigate` — body `{ gameId, beatNumber, linkId }`. Server looks up the beat's `linkContents[linkId]`, applies `costHours` (subtracts from `clockHours`, runs world tick on the consumed hours), applies `unlocksFacts` to `playerKnowledge.investigatedFacts`, applies `unlocksThreats` to `playerKnowledge.knownThreatIds`. Returns the link's `content` plus updated state slice. Idempotent per linkId per beat (a given link can only be opened once per beat).
- `GET /state?gameId=` — returns public state for browser refresh; filtered through `playerKnowledge`
- `POST /reset` — unchanged

---

## 4. Browser UI Changes (`index.html`)

### 4.1 Side panel — minimal HUD
- **Clock face:** hours remaining; color shifts amber below 36h, red below 12h. No exact number under 12h — switches to qualitative ("a handful of hours left").
- **Condition badge:** text chip with status color
- **Threat meters (0–2 visible):** only render where `playerKnowledge.knownThreatIds` includes the threat AND `effectiveProgress > 0`. Display: icon + displayName + qualitative phase label ("Brewing" / "Moving" / "Imminent"). **No numbers, no fill bar percentage.** Optional fill style is purely visual gradient. If more than 2 threats are known, show the 2 most progressed; the rest collapse into a "..." chip with hover-detail.
- **Threat meter removal on slowdown:** when a known threat's `effectiveProgress` drops to 0 (player action pushed it back), the meter slides off-HUD with a brief acknowledgment. The threat is *not* forgotten — `knownToPlayer` stays true. If new progress later exceeds `slowedBy`, the meter slides back in and the prose for that beat acknowledges the resurgence.

Removed widgets (live in prose only): distance, heat, moves, assets list.

### 4.2 Prose rendering
- Render `segments[]` inline. `text` segments are plain. **`link` segments are styled `***italic + bold***`** — typographically distinct enough that the affordance teaches itself; no onboarding hint required. All link types share this single style; the engine cares about `linkType`, the player does not.
- Click opens a small popup or right-rail slide-in showing `linkContents[linkId].content`.
- If `costHours > 0`, popup shows a confirmation gate: "Investigate? (costs ~Nh)" before consuming the time.
- **Idempotent per linkId per beat (first-click only):** once opened, a link's style shifts to a muted "already read" state. Re-clicking shows the same content with no further `costHours` charge and no additional unlocks.
- Hyperlinks survive across re-renders within the same beat; cleared at next beat.

### 4.3 Choice rendering (changed)
- 2–4 buttons (not always 3)
- **No risk badge.** No stake clause. No cost preview. Buttons display only `text`.
- The model is responsible for conveying weight through prose tone alone.

### 4.4 Terminal screens

All terminal screens are **model-authored** with `runHistory` and the relevant trigger payload as input. The engine never ships canned ending prose — every ending is contextualized to the run that produced it.

- **`reached-king`** — bedside scene. Engine passes `runHistory` (threats completed / stopped / never-learned) and lets the model select among 4 templated shapes:
  - *Clean victory:* most threats stopped; king lives; world largely intact
  - *Costly victory:* king lives but world is permanently changed (ally lost, faction broken)
  - *Pyrrhic:* king lives but at cost the player will carry forward
  - *Ambient irony:* the player saved things they never knew were threatened — the threats they never learned about ripple through the closing prose as discovered-too-late truths
- **`time-up` (clock expiry):** model authors a 100–200-word closing scene. Engine passes elapsed-clock context and any in-progress threats; the prose lands with whatever weight the player's known/unknown state warrants.
- **`time-up` (forced by silent threat completion):** when a forced-end threat completes regardless of player knowledge, this is its own dramatic shape. Engine passes the threat's `onComplete.majorEvent`, plus a flag indicating whether the player ever learned of the threat. If they did, the ending lands as expected dread realized. **If they never knew** (the `ambient-irony` failure case — the player wandered while Halric crowned his puppet), the model writes the discovery in the closing scene: the player arrives at Vael's Reach to find black banners and learns the name they never knew. This is the inverse of the `ambient-irony` victory; both are first-class endings, not edge cases.
- **`killed` / `trapped` / `jailed`** — cutscene authored from `lastChoiceRisk: 'desperate'` context + `runHistory`. "Begin Again" button.

---

## 5. Tests

### Existing test files — extend
- `test-validator.mjs`:
  - desperate-only terminal lethality (positive + negative cases)
  - non-lethal surprises legal on controlled/risky
  - clockHours/distance/heat clamps
  - 2..4 choice count
  - server-owned fields stripped (including threat & scheduledEvent server-owned fields)
  - hyperlink schema (unique ids, linkType enum, costHours range, unlocksThreats refs)
- `test-phase4.mjs`: update fixtures to new schema; remove pacing-budget assertions

### New test files
- `test-state-engine.mjs`: delta application with clamps; terminal detection (4 cases)
- `test-threat-engine.mjs`: tick, phase-shift, slowdown, completion, onComplete payload application
- `test-scheduled-events.mjs`:
  - precondition evaluation (cancel vs. fire)
  - revelation queueing with delay
  - revelation strength routing
  - model-authored event ingestion
- `test-knowledge-layer.mjs`: prompt composer reads only from `playerKnowledge`; silent-sim never appears in prompt
- `test-hyperlink-flow.mjs`: `/investigate` endpoint applies costHours, unlocksFacts, unlocksThreats; idempotent per linkId per beat; threat unlock makes threat visible
- `test-prompt-composer.mjs` (extend or new): no pacing-budget block; objective + lean state block present; due-revelations injected; lethality budget present; hyperlink instruction present

---

## 6. Phased Rollout

| Phase | Deliverable                                                                             | Test gate                                                  |
|-------|------------------------------------------------------------------------------------------|------------------------------------------------------------|
| **A** | Schema spec files (`server/schemas/objective.{model-output,runtime-state}.json`)         | User signs off on contract                                 |
| **B** | Validator updates per §1.4                                                               | `test-validator.mjs` green                                 |
| **C** | World bundle migration; `xlsx-to-bundle.mjs` updated; tentpole events authored           | Bundle loads + revalidates                                 |
| **D** | Threat engine (tick, phase, slowdown, completion)                                        | `test-threat-engine.mjs` green                             |
| **E** | Scheduled-events engine (precondition, fire/cancel, revelation queue)                    | `test-scheduled-events.mjs` green                          |
| **F** | Knowledge layer + revelation routing into prompt                                         | `test-knowledge-layer.mjs` green                           |
| **G** | Prompt composer rewrite per §1.5                                                          | Snapshot test of rendered prompt                           |
| **H** | Hyperlink rendering + `/investigate` endpoint                                            | `test-hyperlink-flow.mjs` green                            |
| **I** | Server `/turn/stream` rewired; `/state` filtered through playerKnowledge                 | Manual smoke run reaches each terminal                     |
| **J** | Browser UI per §4 (minimal HUD + hyperlink prose + terminals)                            | Visual playtest of all terminal screens + hyperlink flow   |
| **K** | Playtest pass — 5 runs covering each terminal; tune clamps, tentpole timing, link density | Subjective: does the world feel alive?                     |

---

## 7. Resolved Decisions

All design questions from review are resolved and folded into the spec above. Summary for traceability:

1. **Tentpole authored events for Ember Crown v1:** ~6 events — king's decline at 24h / 48h / 72h; Halric phase-shifts at 40h / 75h; comet zenith at 60h.
2. **Cancelled-counterfactual revelation default:** 70% `quiet` (delayed indirect evidence); 30% `silent` (player never learns). Most ripples surface; some are kindnesses the world keeps.
3. **Hyperlink budget per beat:** capped at 6; per-link content ≤ 50 words. Token cost monitored at Phase K.
4. **Player investigation mechanism:** unified through hyperlinks with `costHours > 0`. No separate "ask" verb.
5. **Macro-threat authorship — flexible.** Both bundle-authored and model-authored macro-threats are permitted. Model-authored capped at 2 per game (see §1.4).
6. **Investigation time-cost share:** target ~10% of the 96h budget (≈10h) for a curious-player run; tune at Phase K.
7. **HUD overflow when >2 known threats:** show the 2 most progressed; collapse the rest into a "..." chip with hover-detail. HUD does not grow.
8. **Ending shapes from `runHistory`:** 4 templated shapes for `reached-king` (clean / costly / pyrrhic / ambient-irony); plus distinct `time-up` shapes for clock-expiry and silent-threat-completion (see §4.4).
9. **Re-prompt budget on validation fail:** 1 retry.
10. **Choice count distribution:** free 2–4; trust the model.
11. **Hyperlink convention onboarding:** none. The `***italic + bold***` typographical differential carries the affordance — see §4.2.
12. **Hyperlink idempotency:** first-click only per `linkId` per beat. Re-clicking shows the cached content with no additional `costHours` and no additional unlocks.
13. **Threat slowed past 0:** `effectiveProgress = max(0, progress - slowedBy)`. When a known threat's effective progress hits 0, the HUD meter is removed; the threat object remains in state with `knownToPlayer: true`. If new progress later exceeds `slowedBy`, the meter slides back in and the model is flagged to acknowledge the resurgence in prose.
14. **Off-screen threat completion forcing the ending:** completion fires regardless of player knowledge. The ending screen is model-authored from `runHistory` plus a flag for whether the player ever learned of the threat. The ironic case (silent completion → player discovers it only at the end) is a first-class ending shape, not an edge case.
15. **Hyperlinks in the openingScene:** yes — opening prose carries hyperlinks authored in the world bundle. xlsx authoring template gains a links sheet (see §2).

---

## 8. Out of Scope (v2+)

- Player-directly-authored content (the player makes choices; only the bundle and the model produce threats, scheduled events, and prose)
- Map / location-graph navigation
- Skill stats / dream-charge meta-resource
- Inventory verbs as conditional choices
- Multiple worlds with different objective archetypes
- Persistent run history / cross-run unlocks
- Social mechanics / negotiation sub-systems
- Adaptive hyperlink density (more links for active investigators, fewer for skimmers)
- Misinformation layer (NPCs lying; rumors that contradict world truth)

---

## 9. Risk Register

| Risk                                                     | Mitigation                                                              |
|----------------------------------------------------------|-------------------------------------------------------------------------|
| Model uses `desperate` outcomes too eagerly              | Lethality-budget instruction; tune via Phase K                          |
| Open structure → bland generic medieval                  | Keep full world bible + character roster + tentpole events in every prompt |
| Player feels arbitrary deaths                            | Lethality gate: only desperate-tier choices can terminate the run       |
| HUD bloat creeps back as features are added              | Hard cap: clock + condition + 2 visible threat meters. Validate UI in PR review |
| Model leaks silent-sim through prose                     | Engine never feeds `worldState` to prompt; only `playerKnowledge`       |
| Hyperlink budget balloons output tokens                  | Validator caps links/beat; per-link content ≤ 50 words; cost monitored in log |
| Counterfactuals fire silently and player never feels weight | Default revelation `quiet`+delayed; only ~30% truly silent. Phase K subjective check |
| Player misses the "earned HUD" mechanic and never investigates | Tentpole events surface loudly enough to teach the convention in run 1; world bible mentions investigation in opening prose |
| Tentpole authoring is tedious                            | Limit to 5–8 per world; provide xlsx sheets with consistent shape       |
| Threat slowdown encourages spam-disrupt play             | Slowdowns require `desperate` choices and have authored caps per threat |
| Investigation cost balance feels punishing or trivial    | Phase K tuning; world bundle controls per-link `costHours` defaults     |

---

## 10. Build Status

Design approved. All 15 review questions resolved (§7). Ready to begin Phase A.

- [x] §1.1 player-facing premise (drop `moves-up`; minimal HUD)
- [x] §1.2 runtime state shape (`worldState` vs `playerKnowledge`; `threats` / `scheduledEvents`)
- [x] §1.3 model output contract (structured prose, link contents, scheduled events, threat slowdowns, model-authored macro-threats)
- [x] §1.4 validator rules (lethality gate scope; hyperlink schema; macro-threat caps; server-owned strip)
- [x] §1.5 prompt composer (knowledge-layer read; revelation injection; hyperlink, counterfactual, and macro-threat authoring instructions)
- [x] §2 world bundle migration (threats, authoredScheduledEvents, openingScene with hyperlinks)
- [x] §3 server flow (world tick; revelation queue; macro-threat ingestion; threat-meter slide; `/investigate` endpoint)
- [x] §4 browser UI (minimal HUD; italic-bold hyperlinks; first-click idempotency; model-authored ending screens)
- [x] §6 phased rollout order
- [x] §7 design questions resolved

**Next deliverable:** Phase A — schema spec files at `server/schemas/objective.{model-output,runtime-state}.json`.
