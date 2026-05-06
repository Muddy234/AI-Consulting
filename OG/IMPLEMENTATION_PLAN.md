# Ember Crown Showrunner — Implementation Plan

Status: **Approved — building**
Owner: Nate
Generated from design discussion preceding this document. Revised after review.

---

## 1. Goals

Build a real narrative engine on top of the existing localhost middleman server, using the `showrunner-world-template.xlsx` as the authoring template.

The system must:

1. Treat each new run as fully unique — only the world bundle is constant; everything else is generated.
2. Preserve maximum AI flexibility on **prose, choice content, NPC behavior, beat shape**.
3. Maintain world cohesion via deterministic engine controls — counters, schema validation, knowledge scoping, atomic writes, write-ahead logging.
4. Track every actor's evolving knowledge separately so NPCs only reference what they actually know — enforced primarily by **context scoping** at prompt-composition time and secondarily by prompt rule.
5. Persist state to disk so games survive server restarts and players can resume.
6. Stay billing-safe — all model calls go through Claude Agent SDK (subscription auth), no API key.

## 2. Non-Goals (explicitly deferred)

- Director View panel and `/state/<gameId>` introspection endpoint
- Replay / regression testing tool
- Multi-player / shared-world support
- Free-text player input (multiple choice only for v1)
- Networked / non-localhost play
- Streaming response to the browser via SSE (v2)
- Final decision on xlsx-vs-YAML as long-term authoring format (xlsx → JSON converter bridges it for now)

## 3. Architecture Overview

```
                              [ Authoring (one-time per world) ]
                                            |
                  showrunner-world-template.xlsx
                                            |
                          xlsx-to-bundle.mjs (converter, mtime-aware)
                                            |
                                            v
                              worlds/<world-name>/world.json
                                            |
[ Browser (index.html) ]                    |
        |                                   v
        |  POST /turn         [ Server (server.js) ]
        |  {gameId, choice}            |
        +-------------------->         |
                                       |  load world.json (cached)
                                       |  load state/<gameId>.json
                                       |  load logs/<gameId>.jsonl (last N)
                                       |  acquire per-gameId lock
                                       |
                                       v
                              compose staged-turn prompt
                              (with scoped NPC knowledge)
                                       |
                                       v
                              Claude Agent SDK (query)
                                       |
                                       v
                              validate JSON against schema
                              (strict; one re-prompt on failure)
                                       |
                                       v
                              APPEND turn record to logs/<gameId>.jsonl
                              (write-ahead — survives subsequent crashes)
                                       |
                                       v
                              apply deltas to state/<gameId>.json
                              (atomic write: tmp + fsync + rename)
                                       |
                                       v
        +<-------------------- return {prose, choices, beatNumber, isEnding}
        |
        v
   render in UI
```

**Key principles:**

- **Stateless server.** No in-memory SDK session resume. Every turn rebuilds context from disk. Server can crash and recover with zero data loss.
- **Write-ahead logging.** Log entry is written *before* state is mutated. On crash recovery, log is the truth; state is rebuilt by replaying any log entries the state file hasn't yet applied.
- **Engine vs. prompt rules.** Engine rules (schema, locking, counters, knowledge scoping, write-ahead log) live in code and are tight. Prompt rules (voice, world constraints, adaptation) live in the system prompt and are kept light.
- **Server owns deterministic state.** beatNumber, worldDay, cumulativeHoursElapsed — these are incremented in code, never trusted from the model.
- **Knowledge isolation via context scoping.** The prompt composer only sends the model the knowledge graphs of NPCs *in the current scene*. Off-screen NPCs are summarized with no knowledge attached. The model literally cannot leak what it isn't shown. This is the structural mitigation for the leak risk; the prompt rule is a soft secondary defense.

## 4. Data Model

### 4.1 World Bundle (`worlds/<world>/world.json`)

Generated from the xlsx, read once at server startup, immutable at runtime.

```json
{
  "worldName": "ember-crown",
  "displayName": "The Ember Crown",
  "tagline": "...",
  "voice": "Sparse. Weighty. No melodrama. ...",
  "settingAndTone": "Medieval fantasy, mythic-grim. ...",
  "structuralObjective": {
    "thematic": "An era ends; the player is the catalyst.",
    "climaxType": "succession",
    "absoluteEmotionalWeight": "irreversible, quiet, costly"
  },
  "worldBible": {
    "geography": "...",
    "factions": "...",
    "recentHistory": "...",
    "currentCrisis": "..."
  },
  "worldConstraints": "Medieval. No firearms, electronics, modern medicine. Magic exists but rare and costly. Travel takes days; messages take messengers. ...",
  "adaptationRules": "Influence, never force. NPCs are physical. Honor every player choice. Adapt the objective's form, not its existence.",
  "pacingBudget": {
    "targetBeatCount": 6,
    "climaxByBeat": 6,
    "tokensPerBeat": 1000
  },
  "characters": [
    {
      "id": "sera",
      "name": "Sera",
      "role": "Messenger / Guide",
      "physical": "...",
      "voice": "...",
      "motivations": "...",
      "allegiances": "...",
      "startingLocation": "...",
      "startingStatus": "...",
      "baselineKnowledge": [
        { "fact": "the king is being poisoned", "confidence": "certain", "source": "authored" },
        { "fact": "Halric is responsible", "confidence": "suspected", "source": "authored" }
      ],
      "notes": "Authoring hint — passed through to the prompt for this NPC's bible block."
    }
  ],
  "openingBeat": {
    "title": "I. The Riders",
    "setting": "Day 1, dawn, Wren's Hollow.",
    "prose": "...",
    "choices": [
      { "label": "A", "text": "Open the door before she can knock.", "type": "canonical" },
      { "label": "B", "text": "Stay silent. Do not answer.", "type": "divergent" },
      { "label": "C", "text": "Slip out the back, into the woods.", "type": "divergent" }
    ]
  },
  "playerStartingState": {
    "location": "Wren's Hollow (own home)",
    "condition": "well-fed, healthy, sleep-deprived",
    "inventory": ["hunting knife", "cloak", "three days' food"],
    "privateKnowledge": [
      { "fact": "has dreamed of fire and a burning crown for weeks", "confidence": "certain", "source": "authored" }
    ],
    "expressedKnowledge": []
  }
}
```

### 4.2 Runtime State (`state/<gameId>.json`)

Mutable per-player. Atomic writes (write to `.tmp`, fsync, rename). The `lastAppliedLogBeat` field is critical for crash recovery — it records the highest beatNumber that has been fully applied to this state file.

```json
{
  "gameId": "ember-7m4kx9",
  "worldName": "ember-crown",
  "createdAt": "2026-05-05T...",
  "lastTurnAt": "2026-05-05T...",
  "beatNumber": 4,
  "lastAppliedLogBeat": 4,
  "worldState": {
    "worldDay": 3,
    "cumulativeHoursElapsed": 56,
    "timeOfDay": "dusk",
    "cometStage": "near-zenith",
    "kingStatus": "dying",
    "crownStatus": "dormant",
    "crownLocation": "king's chamber, Vael's Reach",
    "antagonistPower": "advisor",
    "majorEvents": [
      "Sera met player at gate",
      "Player rode east with Sera"
    ]
  },
  "playerState": {
    "location": "Eastern road, two days from Vael's Reach",
    "condition": "tired",
    "inventory": ["hunting knife", "cloak", "Sera's silver pin (gift)"],
    "privateKnowledge": [...],
    "expressedKnowledge": [...],
    "relationships": { "Sera": "bonded", "Halric": "wary" },
    "internalState": { "dreamIntensity": "rising", "resolve": "tested" }
  },
  "npcStates": {
    "sera": {
      "location": "Eastern road, with player",
      "status": "alive, healthy, wary",
      "motivationDelta": null,
      "currentKnowledge": [
        { "fact": "the king is being poisoned", "confidence": "certain", "source": "authored" },
        { "fact": "player carries the dream-mark", "confidence": "certain", "source": "Beat 1" },
        { "fact": "player abandoned her at bandit pass", "confidence": "certain", "source": "Beat 3" }
      ]
    },
    "halric": {
      "location": "Vael's Reach keep",
      "status": "scheming, increasingly impatient",
      "motivationDelta": null,
      "currentKnowledge": [...]
    }
  },
  "plotTrajectory": {
    "currentPath": "Companion",
    "planState": "Adapting",
    "targetEnding": "Coronation (bruised)",
    "nextNeededEvent": "Player must reach the king's chamber while king is alive",
    "adaptationNotes": "Player abandoned Sera at bandit pass; relationship cooled."
  },
  "forwardProjection": {
    "next2BeatsTarget": "Arrival at the keep, confrontation with Halric's people",
    "tonalAim": "rising dread, less coordination than the player would like",
    "currentConfidence": "moderate"
  }
}
```

**Time advancement (deterministic, server-side):**

- Source of truth: `worldState.cumulativeHoursElapsed` (integer hours since story start).
- Each turn the model returns `worldImpacts.stateChanges.timeElapsed` as a string. The delta-applier parses it via a fixed lookup table:
  - `"N hours"` / `"N hour"` → N
  - `"half a day"` / `"half day"` → 12
  - `"N days"` / `"a day"` / `"the next day"` → N×24 (or 24)
  - `"the next morning"` / `"by morning"` → advance to next 06:00 boundary
  - `"a few hours"` / `"some hours"` → 4
  - `"moments later"` / `"shortly"` / `null` / unrecognized → 0 (logged as warning)
- Server adds the parsed value to `cumulativeHoursElapsed`.
- `worldDay = Math.floor(cumulativeHoursElapsed / 24) + 1`.
- `timeOfDay` is derived from `cumulativeHoursElapsed % 24` against a fixed table: 0–5 = night, 5–9 = dawn, 9–17 = midday, 17–20 = dusk, 20–24 = night.
- The model never sets `worldDay` or `timeOfDay` directly. If it tries, the validator strips those fields from the delta.

### 4.3 Beat Log (`logs/<gameId>.jsonl`)

Append-only. One JSON object per line. **The single source of truth** for what happened. Written *before* state is mutated.

```jsonl
{"ts":"...","beatNumber":1,"playerChoice":null,"modelInput":null,"modelOutput":"...opening beat...","stateBefore":null,"intendedStateAfter":{...},"tokensIn":0,"tokensOut":0,"applied":true}
{"ts":"...","beatNumber":2,"playerChoice":"A","modelInput":"...","modelOutput":{...},"stateBefore":{...},"intendedStateAfter":{...},"tokensIn":1240,"tokensOut":980,"applied":true}
```

The `applied` flag records whether the state file actually got updated. On crash recovery, any entry with `applied: false` (or whose beatNumber > state.lastAppliedLogBeat) is replayed.

The "Recent History" sent to the model each turn is derived from: **the opening beat (always) + the last 3 entries** of this file.

## 5. Per-Turn Flow

1. Browser POSTs `{gameId, choice}` to `/turn`.
2. Server acquires per-gameId mutex (queues if a turn is in flight for the same gameId).
3. Server loads cached `world.json`, `state/<gameId>.json`, opening-beat log entry + last 3 log entries.
4. Server scopes context for this turn:
   - Player's full knowledge (private + expressed) — always included.
   - `currentKnowledge` of NPCs in current scene only.
   - Off-screen NPCs: name + role + last-known location + status only — **no knowledge fields attached**.
   - Recent history: opening beat prose + last 3 beats' prose.
   - Pacing pressure: if `state.beatNumber >= world.pacingBudget.climaxByBeat`, append a `[CLIMAX REQUIRED]` block (see §6).
5. Server composes the staged-turn prompt:

```
[VOICE BLOCK]
[STRUCTURAL OBJECTIVE — thematic, not mechanical]
[WORLD CONSTRAINTS — short paragraph]
[ADAPTATION RULES — short paragraph]
[NPC INVENTION RULES — see §6]
[CHARACTER BIBLES — only NPCs in scope, including their `notes` field]
[CURRENT STATE]
  worldState (excluding cumulativeHoursElapsed — internal only)
  playerState
  scopedNpcStates (knowledge only for in-scene NPCs)
  plotTrajectory
[PRIOR FORWARD PROJECTION — framed as overridable hypothesis]
[RECENT HISTORY — opening beat + last 3 beats, prose only]
[KNOWLEDGE ISOLATION RULE — short prompt rule, secondary defense]
[CLIMAX REQUIRED — only injected when beatNumber >= climaxByBeat]
[PLAYER'S MOST RECENT CHOICE]
[OUTPUT SCHEMA — strict JSON shape required]
```

6. Server calls Agent SDK `query()`.
7. Server validates response against JSON Schema:
    - On failure: send one re-prompt using a fixed-string template in `validator.mjs` — *"Your previous response failed schema validation at `<path>`: `<error>`. Return a corrected response that conforms to the schema exactly. Do not include any text outside the JSON object."*
    - On second failure: return 500 to browser, do not write log, do not mutate state.
    - On success: continue.
8. **WRITE-AHEAD:** Server appends turn record to `logs/<gameId>.jsonl` with `applied: false` and the full `intendedStateAfter` payload.
9. Server applies deltas in-memory:
    - Increments `beatNumber`.
    - Parses `timeElapsed`, advances `cumulativeHoursElapsed`, derives `worldDay` and `timeOfDay`.
    - Applies `worldImpacts.worldStateDeltas` (validator already stripped server-owned fields).
    - Applies `npcImpacts[]` to each NPC's state and `currentKnowledge` (provenance auto-tagged: `source = "Beat <n>"`).
    - Updates `playerState` from any new knowledge gained / location change.
    - Updates `plotTrajectory` and `forwardProjection`.
    - Appends `worldImpacts.majorEventLogged` (if any) to `worldState.majorEvents` (rolling buffer, cap at 12).
    - Sets `lastAppliedLogBeat = beatNumber`.
10. Server writes new state atomically: `state/<gameId>.json.tmp` → fsync → rename.
11. Server updates the log entry's `applied: true` (via a separate small append: `{"beatNumber":N,"applied":true,"ts":"..."}` — keeps the log strictly append-only; recovery reads forward to find the latest `applied` marker per beat).
12. Server releases mutex.
13. Server returns `{prose, choices, beatNumber, isEnding}` to browser.
14. Browser renders.

**Turn 1 special case:** opening beat comes from `world.json.openingBeat`. No model call. State file is created with starting state. Log gets a synthetic beat-1 entry with `applied: true`.

### 5.1 Crash recovery

On server startup, for each `state/*.json`:

1. Load state file. Read `lastAppliedLogBeat`.
2. Tail `logs/<gameId>.jsonl`. For each entry with `beatNumber > lastAppliedLogBeat`:
   - If a matching `applied: true` marker exists later in the log: the state file is stale. Replay the entry's `intendedStateAfter` payload by overwriting the relevant state buckets, set `lastAppliedLogBeat`, atomic-write.
   - If no `applied: true` marker exists: the turn was logged but never applied (crash between step 8 and step 11). Replay the same way; on success, append the `applied: true` marker.
3. If state file has `beatNumber > lastLogBeat`: log a warning. State is ahead of log — should not happen, indicates manual edit or disk corruption. Do not auto-correct; surface to operator.

This routine runs in `lib/recovery.mjs`, called once on server boot. Per-game recovery is fast (constant work per file).

### 5.2 Context scoping (the leak mitigation)

When composing the prompt in step 5, the server does not blanket-include all NPC state. It builds a scoped view:

- **In-scene NPCs:** physically co-located with the player at `playerState.location`. Full state included: location, status, motivationDelta, full `currentKnowledge`, notes.
- **Off-screen NPCs:** anyone else in `npcStates`. Reduced to: `id, name, role, lastKnownLocation, lastKnownStatus`. **No knowledge field.**
- **Player knowledge:** always fully included (this is the residual leak surface — see §13).

In-scene determination: simple substring/proximity match on `playerState.location` vs. `npcStates[id].location`. Tunable later. The model's `npcImpacts[]` can include off-screen NPCs (e.g., Halric scheming in his keep) — the model still reasons about them, but it does so without their knowledge graph in context.

## 6. Prompt Output Schema (model must return this shape)

```json
{
  "worldImpacts": {
    "stateChanges": {
      "timeElapsed": "12 hours",
      "worldStateDeltas": { "kingStatus": "dying" }
    },
    "majorEventLogged": "Player and Sera made camp in the Dead Pines."
  },
  "npcImpacts": [
    {
      "npcId": "sera",
      "locationDelta": null,
      "statusDelta": "weary",
      "motivationDelta": null,
      "knowledgeGained": [
        { "fact": "...", "confidence": "certain" }
      ],
      "offScreenAction": null
    },
    {
      "npcId": "halric",
      "offScreenAction": "Dispatched two more searchers along the eastern road.",
      "knowledgeGained": [
        { "fact": "the dreamer is moving east", "confidence": "suspected" }
      ]
    }
  ],
  "narrativeResponse": {
    "resolutionProse": "...what happened from the player's choice, 80-120 words...",
    "nextBeat": {
      "title": "IV. The Soldier in the Pines",
      "intro": "...150-200 words...",
      "choices": [
        { "label": "A", "text": "...", "type": "canonical" },
        { "label": "B", "text": "...", "type": "divergent" },
        { "label": "C", "text": "...", "type": "divergent" }
      ]
    },
    "isEnding": false
  },
  "forwardProjection": {
    "next2BeatsTarget": "Arrival at the keep",
    "tonalAim": "rising dread, the gates are not what they were",
    "currentConfidence": "moderate"
  },
  "directorReasoning": "Player diverged at bandit pass; trajectory adapting. Sera's warmth dialed down."
}
```

The schema validator enforces:

- All required fields present
- Enums match allowed values
- `npcImpacts[].npcId` exists in the world bundle's `characters[]` (this is the persistent-NPC restriction — see below)
- `narrativeResponse.choices` has exactly 3 entries with required labels and a single `type: "canonical"`
- `worldStateDeltas` only modifies allowed fields with allowed enum values; any attempt to set `worldDay`, `timeOfDay`, or `cumulativeHoursElapsed` is silently stripped (server-owned)

### NPC invention rules (in the prompt)

```
NPC INVENTION RULES:
- You may name and use background NPCs in prose freely (a passing merchant, a kitchen mistress, a wounded soldier on the road). The world should feel populated.
- Background NPCs exist only in this beat's prose. They have no persistent state and you should not assume the player can return to them later.
- Persistent NPCs — anyone you record in `npcImpacts[]` — must reference an `npcId` from the character bibles above. Do not invent new persistent NPCs.
- If a background character becomes important, write them through the bundle NPCs' actions instead (e.g., Sera notices and remarks).
```

### Forward projection framing (in the prompt)

```
PRIOR FORWARD PROJECTION — for continuity only:
Last turn you projected: <text>.
This was a hypothesis. The player's most recent choice may have invalidated it.
Reassess freely. Do not steer toward this projection if the player has diverged.
```

### Climax-required block (only when beatNumber >= climaxByBeat)

```
[CLIMAX REQUIRED]
This story has reached its pacing budget. The structural objective MUST resolve in this beat or the next. Stage the climax now.
```

If after one more turn there is still no resolution (next call also has `isEnding: false`), the prompt escalates:

```
[ENDING REQUIRED — FINAL]
Generate an ending. The era ends in this beat regardless of player position. Set isEnding: true.
```

## 7. File Layout (after implementation)

```
OG/
├── index.html                                  # browser UI (modified to consume new schema)
├── README.md
├── IMPLEMENTATION_PLAN.md                      # this file
├── showrunner-world-template.xlsx              # authoring template
├── worlds/
│   └── ember-crown/
│       └── world.json                          # generated from xlsx by converter
├── state/                                      # per-game live state (gitignored)
│   └── ember-7m4kx9.json
├── logs/                                       # per-game append-only logs (gitignored)
│   └── ember-7m4kx9.jsonl
└── server/
    ├── start.cmd
    ├── server.js                               # rewritten to use staged-turn flow
    ├── package.json
    ├── package-lock.json
    ├── node_modules/
    ├── lib/
    │   ├── config.mjs                          # MODEL, paths, constants — single source
    │   ├── world-bundle.mjs                    # loads + caches world.json; validates against schema
    │   ├── state-store.mjs                     # atomic read/write of state files
    │   ├── beat-log.mjs                        # append + tail of jsonl logs; applied-marker helpers
    │   ├── recovery.mjs                        # crash-recovery routine (replay unapplied log entries)
    │   ├── prompt-composer.mjs                 # builds the staged-turn prompt; context scoping
    │   ├── schema.mjs                          # JSON schemas (bundle, runtime state, model output)
    │   ├── validator.mjs                       # validates model output; re-prompt template constant
    │   ├── delta-applier.mjs                   # applies model deltas; deterministic time advancement
    │   └── lock.mjs                            # per-gameId mutex
    └── tools/
        └── xlsx-to-bundle.mjs                  # converter; mtime-aware unless --force
```

`.gitignore` additions: `state/`, `logs/`, `read-xlsx.ps1`.

## 8. Build Phases

Build in this order. Each phase ends with a working checkpoint that can be tested before moving on.

### Phase 1 — World bundle + converter
- Write `tools/xlsx-to-bundle.mjs` that reads the xlsx and emits `worlds/ember-crown/world.json`.
- **mtime-aware:** by default skip regeneration if `world.json` is newer than the xlsx. Accept `--force` to override.
- Server invokes the converter on startup; converter is silent on no-op.
- Hand-verify the generated JSON matches the xlsx contents.
- **Checkpoint:** `world.json` exists and looks right; re-running server doesn't clobber a manually edited bundle.

### Phase 2 — Schema + validator
- Define JSON schemas in `lib/schema.mjs` for: world bundle, runtime state, model output.
- Build `lib/validator.mjs` with strict validation + one-retry re-prompt logic. Re-prompt wording lives as a single exported constant.
- Validate the world bundle on load (`world-bundle.mjs`); friendly errors that name the offending field.
- Unit-test by feeding hand-crafted good and bad model outputs.
- **Checkpoint:** validator correctly accepts good outputs, re-prompts on bad ones, and surfaces clean errors on bundle problems.

### Phase 3 — State store + beat log + recovery
- Build `lib/state-store.mjs` (atomic read, atomic write via tmp+fsync+rename).
- Build `lib/beat-log.mjs` (append a line; tail last N lines; helper to write `applied: true` markers; helper to scan for unapplied entries).
- Build `lib/recovery.mjs` (on boot, walk all state files; replay any unapplied log entries).
- Build `lib/lock.mjs` (per-gameId mutex).
- **Checkpoint:** can create, read, mutate, persist, and crash-recover a game state file.

### Phase 4 — Prompt composer + delta applier
- Build `lib/prompt-composer.mjs`:
  - Context scoping (in-scene vs. off-screen NPCs)
  - Prior-projection framing block
  - Climax-required block (conditional)
  - Recent history = opening beat + last 3
  - NPC invention rules block (constant)
  - Knowledge isolation rule (constant)
- Build `lib/delta-applier.mjs`:
  - Deterministic `timeElapsed` parser with the fixed lookup table
  - `worldDay` + `timeOfDay` derivation from `cumulativeHoursElapsed`
  - Strip server-owned fields from `worldStateDeltas`
  - Apply `npcImpacts[]` with provenance auto-tagging
  - Append-and-cap `majorEvents` (cap at 12)
- **Checkpoint:** can simulate a turn end-to-end manually with mock model output.

### Phase 5 — Server integration
- Add `lib/config.mjs` with `MODEL = 'claude-sonnet-4-5'` and shared paths.
- Rewrite `server.js` `/turn` handler to use the new write-ahead flow.
- Wire in `/reset` (delete state + log files for gameId) and `/health` (unchanged).
- Hardcoded turn-1 path: opening beat from world bundle, no model call.
- Recovery routine runs on boot.
- **Checkpoint:** end-to-end turn works against the real Agent SDK.

### Phase 6 — Browser update
- Update `index.html` to send/receive new schema.
- Display prose + 3 choices as before.
- Engine state stays hidden from the player.
- **Checkpoint:** play a full game start to climax in the browser.

### Phase 7 — Hardening
- Atomic writes verified under simulated crash (kill server mid-turn at each of: between log-append and state-write; between state-write and applied-marker; verify recovery on next boot).
- Concurrency lock verified (two simultaneous POSTs to same gameId process serially).
- Schema re-prompt verified (force a bad model output; confirm one retry then clean error).
- Token budget overrun (force a long output; verify graceful handling and a flag in the log entry).
- Prompt regression snapshot test (one canonical input → output captured; comparison check when prompts change).
- Past-pacing-budget escalation verified (force the game past beat 6; confirm `[CLIMAX REQUIRED]` injected; force again, confirm `[ENDING REQUIRED — FINAL]` injected).
- **Checkpoint:** ready for real play.

## 9. Open Questions / Decisions Closed in Review

All four questions from the original draft have been resolved:

- **Phase order:** confirmed.
- **NPC invention rule:** background (prose-only) NPCs allowed; persistent NPCs (entries in `npcImpacts[]`) restricted to bundle characters. Enforced by validator.
- **Past-pacing-budget rule:** `[CLIMAX REQUIRED]` block at climaxByBeat; `[ENDING REQUIRED — FINAL]` after one more turn if unresolved.
- **Knowledge isolation:** primary defense is engine-side context scoping (only in-scene NPCs get their knowledge in the prompt). Prompt rule is secondary. Residual player-knowledge leak accepted as v1 limitation (see §13).

## 10. Cost Estimate

Rough per-turn budget on Sonnet 4.5:
- Input: ~3-8k tokens (grows over the run as state accumulates)
- Output: ~1k tokens

Five-beat game: ~30-50k total tokens. On the Max subscription, this is fine — the quota is generous and the bottleneck is wall-clock time, not cost.

The beat log records `tokensIn / tokensOut` per turn so expensive runs are visible.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Model returns malformed JSON | Strict schema validation + one-retry re-prompt. Then clean error to browser. |
| Knowledge leak via NPC referencing facts they shouldn't know | Context scoping at prompt-composition: off-screen NPCs have no knowledge field in context. Prompt rule as secondary defense. Residual: player's own private knowledge is always in scope (see §13). |
| Prose quality drops as schema grows | Voice block kept at top of prompt. World constraints kept short. Engine rules stay in code, never in prompt. |
| State file corruption from mid-write crash | Atomic writes (tmp + fsync + rename). |
| Crash between log-write and state-write | Write-ahead log + recovery routine: state is rebuilt from log entries with `applied: false` on next boot. |
| Concurrent turns from same player | Per-gameId mutex. |
| Ballooning context | Context scoping (only in-scene NPCs); recent history capped at opening + 3; majorEvents capped at 12. |
| Subscription quota hit | Token-per-turn logging exposes expensive runs. Output budget keeps prose tight. |
| AI path-locks on its own forwardProjection | Projection passed back as explicit overridable hypothesis, not as plan. |
| AI overruns pacing budget | `[CLIMAX REQUIRED]` and `[ENDING REQUIRED — FINAL]` escalation blocks. |
| xlsx authoring work clobbered by converter | mtime-aware: regen only if xlsx is newer; `--force` to override. |
| World bundle malformed by hand-edit | Bundle validated against schema on server load with field-level errors. |

## 12. What I Need From You Before Building

All four prior questions resolved. Greenlight given. Building now.

## 13. Known Limitations / v1 Tradeoffs

Documented honestly so they aren't surprises later:

- **Residual knowledge leak surface.** Context scoping prevents the model from leaking off-screen NPC secrets, but the player's own `privateKnowledge` is always in the prompt. A clever-or-careless model could still have an NPC reference player-private content (a dream, an internal thought). Mitigation is the prompt rule, which is soft. There is no engine-side detector for this in v1. Accepted; revisit if it shows up frequently in playtesting.
- **Background NPCs are not persistent.** A merchant the model names in beat 2 has no state, no knowledge, no continuity. If the player wants to revisit them in beat 4, the model must improvise. v2 may auto-promote frequently-referenced background NPCs to persistent state.
- **No streaming.** The browser waits for the full response before rendering. A turn at 3-8k input tokens will be 8-15 seconds of wall-clock. Acceptable for a contemplative narrative game; v2 candidate for SSE streaming.
- **No Director View.** State evolution is visible only by reading the log/state files manually. v2 candidate.
- **No replay tool.** Logs are reproducible in principle, but no harness exists to replay a saved run against a new prompt. v2 candidate.
- **Single-world bundle assumed.** The server reads `worlds/ember-crown/world.json`. Multi-world support (selecting a world at game-start) requires minor changes; deferred until needed.
- **Localhost only.** No auth on `/turn`. If exposed beyond localhost, anyone with the URL can burn the subscription quota. Document loudly in README; do not change binding.
- **NPC scene-detection is naive.** "In scene" is a substring match on `playerState.location` vs. `npcStates[id].location`. Edge cases will exist (player in "Vael's Reach courtyard", NPC in "Vael's Reach keep" — same place semantically, different strings). Tune as needed.
- **Time parser may misread novel phrasings.** The `timeElapsed` lookup table covers common cases; unrecognized strings fall back to 0 hours and log a warning. Add cases as encountered.
