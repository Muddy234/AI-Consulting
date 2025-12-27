# Raspberry Pi Setup Guide

## Prerequisites

- Raspberry Pi 4 (2GB+ RAM recommended)
- Raspberry Pi OS with Desktop (for browser GUI)
- Internet connection
- Monitor/keyboard for initial setup (or SSH)

## Quick Start

### 1. Initial Setup

```bash
# Download the setup script (or copy files to Pi)
cd ~
git clone https://github.com/YOUR_USERNAME/AI-Consulting.git
cd AI-Consulting/ai-agent

# Make scripts executable
chmod +x raspberry_pi_setup.sh
chmod +x install_service.sh

# Run setup
./raspberry_pi_setup.sh
```

### 2. Log Into Your Accounts

Before the bot can work, you need to log into your accounts in Chromium:

```bash
chromium-browser
```

Then log into:
- **Outlook**: https://outlook.office.com
- **Amazon**: https://www.amazon.com (if using shopping features)
- **OpenTable**: https://www.opentable.com (if using reservations)

**Important**: Make sure "Stay signed in" or "Remember me" is checked!

### 3. Test the Bot

```bash
cd ~/AI-Consulting/ai-agent
source venv/bin/activate
python telegram_bot.py
```

Open Telegram and send `/start` to your bot. If it responds, you're good!

### 4. Install as Service (Auto-Start)

```bash
sudo ./install_service.sh
```

The bot will now:
- Start automatically when Pi boots
- Restart if it crashes
- Run 24/7 in the background

## Managing the Service

```bash
# Check status
sudo systemctl status ai-agent-bot

# View live logs
sudo journalctl -u ai-agent-bot -f

# Stop the bot
sudo systemctl stop ai-agent-bot

# Start the bot
sudo systemctl start ai-agent-bot

# Restart the bot
sudo systemctl restart ai-agent-bot

# Disable auto-start
sudo systemctl disable ai-agent-bot
```

## Configuration

Edit `~/.env` or `~/AI-Consulting/ai-agent/.env`:

```bash
# Required
GOOGLE_API_KEY=your-google-api-key
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_USER_ID=your-user-id
TELEGRAM_USER_NAME=YourName

# Browser (auto-detected, but can override)
BROWSER_TYPE=chromium
CHROMIUM_PATH=/usr/bin/chromium-browser
CHROMIUM_USER_DATA=/home/pi/.config/chromium

# Set to true for headless mode (no GUI)
HEADLESS=false
```

## Troubleshooting

### Bot not responding?

1. Check if service is running:
   ```bash
   sudo systemctl status ai-agent-bot
   ```

2. Check logs:
   ```bash
   tail -100 ~/AI-Consulting/ai-agent/bot_service.log
   ```

3. Test manually:
   ```bash
   cd ~/AI-Consulting/ai-agent
   source venv/bin/activate
   python telegram_bot.py
   ```

### Browser not opening?

Make sure you're running with a desktop environment (not headless Raspberry Pi OS Lite).

For headless operation, set `HEADLESS=true` in `.env`, but note that some websites may not work properly in headless mode.

### Session expired?

Log back into the websites in Chromium:
```bash
chromium-browser
```

### Permission errors?

```bash
# Fix ownership
sudo chown -R $USER:$USER ~/AI-Consulting

# Fix executable permissions
chmod +x ~/AI-Consulting/ai-agent/*.sh
```

## Hardware Recommendations

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Raspberry Pi | Pi 3B+ | Pi 4 (4GB) |
| Storage | 16GB SD | 32GB+ SD |
| RAM | 2GB | 4GB |
| Power | 2.5A | 3A USB-C |

## Power Consumption

- Idle: ~3-5W
- Running tasks: ~5-7W
- Monthly cost: ~$0.50-1.00 in electricity

## VNC Remote Access (Optional)

To access the Pi's desktop remotely:

```bash
# Enable VNC on Pi
sudo raspi-config
# Navigate to: Interface Options > VNC > Enable

# Install VNC Viewer on your phone/computer
# Connect to your Pi's IP address
```

This lets you see the browser while tasks run!
