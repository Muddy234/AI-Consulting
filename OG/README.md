# The Ember Crown — Showrunner Wireframe

A browser-based, AI-driven adaptive narrative game. The page (`index.html`) renders the story; a small local Node.js server (`server/server.js`) bridges to Claude via the **Claude Agent SDK**, which uses your existing Claude Code subscription auth (no API key, no per-token billing).

```
[Browser: index.html]  <-->  [localhost:3000 (Node)]  <-->  [Claude Agent SDK]  -->  [Claude]
```

## Prerequisites

These are already installed on this machine. Listed for reference / re-setup:

| Requirement | Where it lives | Why |
|---|---|---|
| Node.js v22.11.0 (portable) | `C:\Users\NateMcBride\node-portable\node-v22.11.0-win-x64` | Runs the local server |
| Claude Code CLI | `C:\Users\NateMcBride\AppData\Local\Microsoft\WinGet\Packages\Anthropic.ClaudeCode_...\claude.exe` | Provides subscription auth |
| Git for Windows (git-bash) | `C:\Users\NateMcBride\AppData\Local\Programs\Git\bin\bash.exe` | The Agent SDK requires git-bash on Windows |
| Active Claude subscription | (your account) | Billing source for AI calls |

The `server/start.cmd` launcher hardcodes the paths above. If any path changes, edit `start.cmd`.

## How to launch

1. Double-click **`server\start.cmd`** (or run it from PowerShell). A console window will open and show:
   ```
   Ember Crown server listening on http://localhost:3000
   ```
   Leave this window open while you play.

2. Open **`index.html`** in a web browser (double-click the file, or drag into the browser).

3. (Optional) Click the **DIAGNOSTIC → Test minimal API call** button on the page to verify the browser can reach the server. You should see `{"ok":true}`.

4. Play the game. Each choice you click sends a turn to the server, which forwards it to Claude and returns the next beat.

## How to stop

Close the console window opened by `start.cmd`, or press **Ctrl+C** in it.

## Project layout

```
OG/
├── index.html              The game UI (single-page)
├── README.md               This file
├── server/
│   ├── start.cmd           Launcher — sets PATH + git-bash, starts Node
│   ├── server.js           Express server, ~70 lines
│   ├── package.json        Node dependencies
│   ├── package-lock.json
│   └── node_modules/       Installed packages (do not commit)
└── (helper scripts from initial setup — safe to delete)
    ├── install-node.ps1
    ├── add-node-to-path.ps1
    └── check-env.ps1
```

## Server endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check, returns `{"ok":true}` |
| POST | `/turn` | Send a player choice, get next beat |
| POST | `/reset` | Clear the server-side session for a `gameId` |

## Troubleshooting

**Browser shows "Cannot reach local server"**
- Confirm the cmd window from `start.cmd` is still open
- Visit `http://localhost:3000/health` directly in the browser

**Server window closes immediately or shows "spawn node ENOENT"**
- The portable Node folder moved or was deleted. Edit `NODE_DIR` in `server\start.cmd`.

**Server logs "Claude Code on Windows requires git-bash"**
- Git for Windows was uninstalled or moved. Edit `CLAUDE_CODE_GIT_BASH_PATH` in `server\start.cmd`.

**Server logs "authentication_failed" or similar**
- Your Claude Code subscription auth has expired. Open a regular terminal and run `claude` to re-authenticate.

## Notes on cost

Calls go through the Agent SDK using Claude Code's stored auth, so they are billed against your **Claude subscription quota** — not pay-per-token API billing. To remain on the subscription path, do not set `ANTHROPIC_API_KEY` in your environment.
