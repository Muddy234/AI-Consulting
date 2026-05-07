# The Ember Crown

A browser-based, AI-driven adaptive narrative game. A king is dying. You have 96 in-fiction hours to reach his bedside. The world ticks regardless of whether you're watching — threats advance off-screen, scheduled events fire, and consequences ripple in ways you may never see.

```
[Browser: index.html]  <-->  [localhost:3000 (Node)]  <-->  [Claude Agent SDK]  -->  [Claude]
```

The page renders structured prose with hyperlinks. The local server runs the simulation, scopes what Claude is allowed to see, and validates every model response against a strict JSON contract.

The full design is in [`OBJECTIVE_REFACTOR_PLAN.md`](./OBJECTIVE_REFACTOR_PLAN.md).

---

## Prerequisites

| Requirement | Where it lives | Why |
|---|---|---|
| Node.js v22.11.0 (portable) | `C:\Users\NateMcBride\node-portable\node-v22.11.0-win-x64` | Runs the local server |
| Claude Code CLI | `C:\Users\NateMcBride\AppData\Local\Microsoft\WinGet\Packages\Anthropic.ClaudeCode_...\claude.exe` | Provides subscription auth |
| Git for Windows (git-bash) | `C:\Users\NateMcBride\AppData\Local\Programs\Git\bin\bash.exe` | The Agent SDK spawns its CLI through git-bash on Windows |
| Active Claude subscription | (your account) | Billing source for AI calls |

`server/start.cmd` hardcodes the Node and git-bash paths. If either moves, edit those two lines.

## How to launch

1. Double-click **`server\start.cmd`** (or run it from PowerShell). A console window opens and shows:
   ```
   [boot] world bundle loaded: ember-crown
   Ember Crown server listening on http://127.0.0.1:3000
   ```
   Leave this window open while you play.

2. Open **`index.html`** in a browser (double-click, or drag into the browser).

3. Play. Each choice sends a turn to the server, which forwards a curated prompt to Claude and returns the next beat.

## How to stop

Close the console window from `start.cmd`, or press **Ctrl+C** in it.

---

## Project layout

```
OG/
├── index.html                      Single-page game UI (HUD + structured prose +
│                                   hyperlink popups + terminal screens)
├── README.md                       This file
├── OBJECTIVE_REFACTOR_PLAN.md      Full design spec (read this for engine details)
├── worlds/
│   └── ember-crown/
│       ├── world.yaml              World bundle SOURCE (committed)
│       └── world.json              Build artifact (gitignored, regenerated at boot)
├── server/
│   ├── start.cmd                   Windows launcher (PATH + git-bash + node server.js)
│   ├── server.js                   Thin Express layer over the orchestrator
│   ├── package.json                Dependencies: ajv, js-yaml, express, cors, agent SDK
│   ├── schemas/
│   │   ├── objective.runtime-state.json   JSON Schema for state files
│   │   └── objective.model-output.json    JSON Schema for per-turn model output
│   ├── lib/
│   │   ├── config.mjs                     Shared paths + constants
│   │   ├── world-bundle.mjs               Loads + validates world.yaml -> world.json
│   │   ├── yaml-to-bundle.mjs             YAML converter (mtime-aware)
│   │   ├── state-store.mjs                Atomic per-game state file I/O
│   │   ├── lock.mjs                       Per-gameId mutex (FIFO)
│   │   ├── beat-log.mjs                   Append-only per-game beat log (.jsonl)
│   │   ├── objective-validator.mjs        Schema + semantic validation, RE_PROMPT_TEMPLATE
│   │   ├── threat-engine.mjs              Macro-threat tick, phase, slowdown, completion
│   │   ├── scheduled-events-engine.mjs    Precondition eval, fire/cancel, revelation queue
│   │   ├── knowledge-layer.mjs            Curated player-visible view (NPC scoping etc.)
│   │   ├── objective-prompt-composer.mjs  System + user prompt assembly
│   │   ├── investigation.mjs              Hyperlink-click flow (POST /investigate)
│   │   ├── state-seeder.mjs               Fresh-game state from bundle
│   │   ├── objective-orchestrator.mjs     Per-turn flow (init / submitChoice / openLink)
│   │   └── model-client.mjs               Thin SDK wrapper + JSON extraction
│   └── tools/
│       ├── test-objective-validator.mjs        51 cases
│       ├── test-yaml-to-bundle.mjs             26 cases
│       ├── test-threat-engine.mjs              65 cases
│       ├── test-scheduled-events.mjs           81 cases
│       ├── test-knowledge-layer.mjs            61 cases
│       ├── test-objective-prompt-composer.mjs  84 cases
│       ├── test-hyperlink-flow.mjs             50 cases
│       ├── test-objective-orchestrator.mjs     60 cases
│       └── check-html-js.mjs                   <script> block syntax sanity for index.html
```

`state/` (per-game runtime files) and `logs/` (per-game beat logs) are created on demand and gitignored.

## Authoring a world

`worlds/ember-crown/world.yaml` is the source of truth. The server regenerates `world.json` from it on boot (mtime-aware). To rebuild manually:

```
cd server
npm run build:bundle
```

Editing the YAML directly is the supported authoring flow. The runtime validator catches missing fields and bad shapes loudly on server boot.

## Running the test suite

```
cd server
npm run test:objective-validator
npm run test:yaml-to-bundle
npm run test:threat-engine
npm run test:scheduled-events
npm run test:knowledge-layer
npm run test:objective-prompt-composer
npm run test:hyperlink-flow
npm run test:objective-orchestrator
```

478 cases total across 8 suites.

## Server endpoints

| Method | Path           | Purpose |
|--------|----------------|---------|
| GET    | `/health`      | Liveness check; returns `{"ok":true}` |
| POST   | `/turn`        | Body `{ gameId, choice? }`. Turn 1 (no `choice`) seeds and returns the opening scene. Turn 2+ (with `choice`) drives the orchestrator. |
| POST   | `/investigate` | Body `{ gameId, beatNumber, linkId }`. Applies cost + unlocks, idempotent per (beatNumber, linkId). |
| GET    | `/state`       | `?gameId=…`; returns `publicState` filtered through the knowledge layer (no `distanceToKing`, no off-screen NPC knowledge). |
| POST   | `/reset`       | Body `{ gameId }`. Wipes state + log files. |

## Troubleshooting

**Browser shows "Cannot reach local server"**
- Confirm the cmd window from `start.cmd` is still open
- Visit `http://127.0.0.1:3000/health` directly in the browser

**Server window closes immediately or shows "spawn node ENOENT"**
- The portable Node folder moved or was deleted. Edit `NODE_DIR` in `server\start.cmd`.

**Server logs "Claude Code on Windows requires git-bash"**
- Git for Windows was uninstalled or moved. Edit `CLAUDE_CODE_GIT_BASH_PATH` in `server\start.cmd`.

**Server logs "authentication_failed" or similar**
- Your Claude Code subscription auth has expired. Open a terminal and run `claude` to re-authenticate.

**`world.yaml` edits don't seem to take effect**
- The converter is mtime-aware. Touch the file (`Get-Item world.yaml | Set-ItemProperty -Name LastWriteTime -Value (Get-Date)`) or run `npm run build:bundle` from `server/`.

## Notes on cost

Calls go through the Agent SDK using Claude Code's stored auth, so they bill against your **Claude subscription quota** — not pay-per-token API billing. Do not set `ANTHROPIC_API_KEY` in your environment.

Each turn currently sends 3–8k input tokens and produces ~1k output tokens. A full 5–10 beat run is well under the daily quota on a Max subscription.
