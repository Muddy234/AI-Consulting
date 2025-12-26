#!/bin/bash
# ============================================
# AI Agent - Install as System Service
# ============================================
# This installs the Telegram bot as a systemd service
# that starts automatically on boot.
#
# Usage:
#   sudo ./install_service.sh
# ============================================

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration
SERVICE_NAME="ai-agent-bot"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_PATH="$PROJECT_DIR/venv/bin/python"
BOT_SCRIPT="$PROJECT_DIR/telegram_bot.py"
USER=$(whoami)

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN} Installing AI Agent as System Service${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${YELLOW}Please run with sudo:${NC}"
    echo "  sudo $0"
    exit 1
fi

# Check if venv exists
if [ ! -f "$PYTHON_PATH" ]; then
    echo "Virtual environment not found at $PYTHON_PATH"
    echo "Please run raspberry_pi_setup.sh first."
    exit 1
fi

# Create systemd service file
echo "Creating systemd service..."

cat > /etc/systemd/system/$SERVICE_NAME.service << EOF
[Unit]
Description=AI Agent Telegram Bot
After=network.target

[Service]
Type=simple
User=$SUDO_USER
WorkingDirectory=$PROJECT_DIR
Environment="PATH=$PROJECT_DIR/venv/bin:/usr/bin"
EnvironmentFile=$PROJECT_DIR/.env
ExecStart=$PYTHON_PATH $BOT_SCRIPT
Restart=always
RestartSec=10

# Logging
StandardOutput=append:$PROJECT_DIR/bot_service.log
StandardError=append:$PROJECT_DIR/bot_service.log

[Install]
WantedBy=multi-user.target
EOF

echo "Service file created at /etc/systemd/system/$SERVICE_NAME.service"

# Reload systemd
echo "Reloading systemd..."
systemctl daemon-reload

# Enable service to start on boot
echo "Enabling service..."
systemctl enable $SERVICE_NAME

# Start the service
echo "Starting service..."
systemctl start $SERVICE_NAME

# Check status
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN} Installation Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "Service status:"
systemctl status $SERVICE_NAME --no-pager
echo ""
echo "Useful commands:"
echo "  sudo systemctl status $SERVICE_NAME   # Check status"
echo "  sudo systemctl stop $SERVICE_NAME     # Stop bot"
echo "  sudo systemctl start $SERVICE_NAME    # Start bot"
echo "  sudo systemctl restart $SERVICE_NAME  # Restart bot"
echo "  sudo journalctl -u $SERVICE_NAME -f   # View logs"
echo ""
echo "Log file: $PROJECT_DIR/bot_service.log"
echo ""
