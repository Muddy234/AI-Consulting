# ============================================
# AI Agent Bot - Windows Task Scheduler Setup
# ============================================
# Run this script as Administrator to set up the bot
# to start automatically when you log in.
#
# Usage:
#   Right-click this file > Run with PowerShell
#   Or: powershell -ExecutionPolicy Bypass -File install_bot_service.ps1
# ============================================

$ErrorActionPreference = "Stop"

# Configuration
$TaskName = "AIAgentTelegramBot"
$ScriptPath = Join-Path $PSScriptRoot "telegram_bot.py"
$PythonPath = "python"  # Or full path like "C:\Users\NateMcBride\AppData\Local\Programs\Python\Python311\python.exe"
$WorkingDir = $PSScriptRoot

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " AI Agent Bot - Service Installer" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Check if task already exists
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($existingTask) {
    Write-Host "Task '$TaskName' already exists." -ForegroundColor Yellow
    $choice = Read-Host "Do you want to (R)eplace, (D)elete, or (C)ancel? [R/D/C]"

    switch ($choice.ToUpper()) {
        "R" {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "Existing task removed. Creating new one..." -ForegroundColor Green
        }
        "D" {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "Task deleted. Bot will no longer start automatically." -ForegroundColor Green
            exit
        }
        default {
            Write-Host "Cancelled." -ForegroundColor Yellow
            exit
        }
    }
}

# Create the scheduled task
Write-Host "Creating scheduled task..." -ForegroundColor Green

$Action = New-ScheduledTaskAction -Execute $PythonPath -Argument "`"$ScriptPath`"" -WorkingDirectory $WorkingDir
$Trigger = New-ScheduledTaskTrigger -AtLogon
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description "AI Agent Telegram Bot - Controls browser automation via Telegram"

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host " Installation Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "The bot will now start automatically when you log in."
Write-Host ""
Write-Host "To manage the task:" -ForegroundColor Cyan
Write-Host "  - Open Task Scheduler (taskschd.msc)"
Write-Host "  - Find '$TaskName' in the list"
Write-Host ""
Write-Host "To start the bot now:" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "To stop the bot:" -ForegroundColor Cyan
Write-Host "  Stop-ScheduledTask -TaskName '$TaskName'"
Write-Host ""

# Offer to start now
$startNow = Read-Host "Start the bot now? [Y/N]"
if ($startNow.ToUpper() -eq "Y") {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Bot started! Send a message to your Telegram bot to test." -ForegroundColor Green
}

Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
