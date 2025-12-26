#!/bin/bash
# ============================================
# AI Agent - Raspberry Pi Setup Script
# ============================================
# Run this script on a fresh Raspberry Pi OS installation
#
# Usage:
#   chmod +x raspberry_pi_setup.sh
#   ./raspberry_pi_setup.sh
# ============================================

set -e  # Exit on error

echo "============================================"
echo " AI Agent - Raspberry Pi Setup"
echo "============================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running on Raspberry Pi
if ! grep -q "Raspberry Pi" /proc/cpuinfo 2>/dev/null && ! grep -q "BCM" /proc/cpuinfo 2>/dev/null; then
    echo -e "${YELLOW}Warning: This doesn't appear to be a Raspberry Pi.${NC}"
    echo "Continuing anyway..."
fi

# ============================================
# Step 1: System Update
# ============================================
echo -e "${GREEN}[1/7] Updating system packages...${NC}"
sudo apt update && sudo apt upgrade -y

# ============================================
# Step 2: Install Python 3.11+
# ============================================
echo -e "${GREEN}[2/7] Installing Python...${NC}"
sudo apt install -y python3 python3-pip python3-venv python3-dev

# Check Python version
PYTHON_VERSION=$(python3 --version | cut -d' ' -f2 | cut -d'.' -f1,2)
echo "Python version: $PYTHON_VERSION"

# ============================================
# Step 3: Install Chromium Browser
# ============================================
echo -e "${GREEN}[3/7] Installing Chromium browser...${NC}"
sudo apt install -y chromium-browser chromium-chromedriver

# Verify installation
CHROMIUM_PATH=$(which chromium-browser)
echo "Chromium installed at: $CHROMIUM_PATH"

# ============================================
# Step 4: Install Git
# ============================================
echo -e "${GREEN}[4/7] Installing Git...${NC}"
sudo apt install -y git

# ============================================
# Step 5: Clone Repository
# ============================================
echo -e "${GREEN}[5/7] Setting up project directory...${NC}"

PROJECT_DIR="$HOME/ai-agent"

if [ -d "$PROJECT_DIR" ]; then
    echo "Project directory already exists. Pulling latest changes..."
    cd "$PROJECT_DIR"
    git pull
else
    echo "Cloning repository..."
    # Replace with your actual repo URL
    read -p "Enter your GitHub repo URL (or press Enter for manual setup): " REPO_URL

    if [ -n "$REPO_URL" ]; then
        git clone "$REPO_URL" "$PROJECT_DIR"
        cd "$PROJECT_DIR"
    else
        mkdir -p "$PROJECT_DIR"
        cd "$PROJECT_DIR"
        echo "Created $PROJECT_DIR - copy your code here manually"
    fi
fi

# ============================================
# Step 6: Create Virtual Environment & Install Dependencies
# ============================================
echo -e "${GREEN}[6/7] Setting up Python virtual environment...${NC}"

cd "$PROJECT_DIR"

# Create venv if it doesn't exist
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

# Activate venv
source venv/bin/activate

# Upgrade pip
pip install --upgrade pip

# Install requirements
if [ -f "requirements.txt" ]; then
    pip install -r requirements.txt
else
    echo "Installing core dependencies..."
    pip install browser-use python-telegram-bot google-generativeai
fi

# Install playwright browsers (alternative to selenium)
# playwright install chromium

# ============================================
# Step 7: Create Environment File
# ============================================
echo -e "${GREEN}[7/7] Setting up environment configuration...${NC}"

ENV_FILE="$PROJECT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "Creating .env file..."

    read -p "Enter your Google API Key: " GOOGLE_API_KEY
    read -p "Enter your Telegram Bot Token: " TELEGRAM_BOT_TOKEN
    read -p "Enter your Telegram User ID: " TELEGRAM_USER_ID
    read -p "Enter your name: " USER_NAME

    cat > "$ENV_FILE" << EOF
# AI Agent Configuration - Raspberry Pi
# ======================================

# Google API Key (from aistudio.google.com)
GOOGLE_API_KEY=$GOOGLE_API_KEY

# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_USER_ID=$TELEGRAM_USER_ID
TELEGRAM_USER_NAME=$USER_NAME

# Browser Configuration (Raspberry Pi uses Chromium)
BROWSER_TYPE=chromium
CHROMIUM_PATH=/usr/bin/chromium-browser
CHROMIUM_USER_DATA=$HOME/.config/chromium

# Set to true to run browser headless (no GUI)
HEADLESS=false
EOF

    echo "Created .env file at $ENV_FILE"
else
    echo ".env file already exists"
fi

# ============================================
# Setup Complete
# ============================================
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN} Setup Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "Next steps:"
echo ""
echo "1. Log into your accounts in Chromium:"
echo "   chromium-browser"
echo "   - Go to outlook.office.com and log in"
echo "   - Go to amazon.com and log in"
echo "   - Go to opentable.com and log in"
echo ""
echo "2. Test the bot:"
echo "   cd $PROJECT_DIR"
echo "   source venv/bin/activate"
echo "   python telegram_bot.py"
echo ""
echo "3. Set up auto-start (run as a service):"
echo "   sudo ./install_service.sh"
echo ""
echo "4. Send /start to your Telegram bot to test!"
echo ""
