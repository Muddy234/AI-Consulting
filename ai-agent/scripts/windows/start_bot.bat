@echo off
REM ============================================
REM AI Agent Telegram Bot Launcher
REM ============================================
REM This script starts the Telegram bot in the background
REM
REM To run at startup:
REM 1. Press Win+R, type: shell:startup
REM 2. Create a shortcut to this file in that folder
REM ============================================

cd /d "%~dp0"
title AI Agent Bot

echo ============================================
echo  AI Agent Telegram Bot
echo ============================================
echo.
echo Starting bot... (minimize this window)
echo Bot will keep running in background.
echo.
echo To stop: Close this window or Ctrl+C
echo ============================================

python telegram_bot.py

pause
