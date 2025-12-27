' ============================================
' AI Agent Telegram Bot - Hidden Launcher
' ============================================
' This script starts the bot completely hidden (no window)
' Perfect for startup - runs silently in background
'
' To run at startup:
' 1. Press Win+R, type: shell:startup
' 2. Copy this file to that folder
' ============================================

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "pythonw telegram_bot.py", 0, False
