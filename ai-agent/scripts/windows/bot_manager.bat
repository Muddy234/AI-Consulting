@echo off
REM ============================================
REM AI Agent Bot Manager
REM ============================================

:menu
cls
echo ============================================
echo  AI Agent Bot Manager
echo ============================================
echo.
echo  1. Start bot (visible window)
echo  2. Start bot (hidden/background)
echo  3. Stop bot
echo  4. Check bot status
echo  5. View bot logs
echo  6. Install as startup service
echo  7. Exit
echo.
set /p choice="Select option (1-7): "

if "%choice%"=="1" goto start_visible
if "%choice%"=="2" goto start_hidden
if "%choice%"=="3" goto stop
if "%choice%"=="4" goto status
if "%choice%"=="5" goto logs
if "%choice%"=="6" goto install
if "%choice%"=="7" exit
goto menu

:start_visible
cd /d "%~dp0"
start "AI Agent Bot" python telegram_bot.py
echo Bot started in new window.
pause
goto menu

:start_hidden
cd /d "%~dp0"
start "" pythonw telegram_bot.py
echo Bot started in background (hidden).
pause
goto menu

:stop
echo Stopping bot...
taskkill /f /im python.exe /fi "WINDOWTITLE eq AI Agent Bot" 2>nul
taskkill /f /im pythonw.exe 2>nul
echo Bot stopped.
pause
goto menu

:status
echo.
echo Checking for running bot processes...
echo.
tasklist /fi "imagename eq python.exe" /fo table 2>nul | findstr /i "python"
tasklist /fi "imagename eq pythonw.exe" /fo table 2>nul | findstr /i "pythonw"
echo.
pause
goto menu

:logs
cd /d "%~dp0"
if exist telegram_bot.log (
    echo Opening log file...
    notepad telegram_bot.log
) else (
    echo No log file found yet.
    pause
)
goto menu

:install
cd /d "%~dp0"
echo.
echo This will install the bot as a Windows startup task.
echo You may need to run as Administrator.
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0install_bot_service.ps1"
pause
goto menu
