@echo off
REM Launcher: sets up environment so the Claude Agent SDK can spawn its internal CLI.

set "NODE_DIR=C:\Users\NateMcBride\node-portable\node-v22.11.0-win-x64"
set "PATH=%NODE_DIR%;%PATH%"
set "CLAUDE_CODE_GIT_BASH_PATH=C:\Users\NateMcBride\AppData\Local\Programs\Git\bin\bash.exe"

cd /d "%~dp0"
"%NODE_DIR%\node.exe" server.js
