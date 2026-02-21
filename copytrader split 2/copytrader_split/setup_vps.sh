#!/bin/bash
# CopyTrader v4.1 — VPS Setup Script
# Ubuntu 22.04 LTS
#
# Usage (agent mode — connects to Render web server):
#   WEB_SERVER_URL=https://your-app.onrender.com VPS_AGENT_SECRET=your-secret bash setup_vps.sh agent
#
# Usage (full standalone mode — everything on VPS):
#   bash setup_vps.sh full

set -e

MODE="${1:-agent}"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()     { echo -e "${RED}[ERR]${NC} $*"; exit 1; }

echo ""
echo -e "${CYAN}⚡ CopyTrader v4.1 VPS Setup — Mode: ${MODE}${NC}"
echo "================================================="
echo ""

# ── System packages ────────────────────────────────────────────────────────────
info "Updating system packages..."
apt-get update -qq
apt-get install -y -qq curl wget git unzip xvfb

# ── Node.js 20 ─────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]]; then
  info "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
success "Node.js $(node -v)"

# ── PM2 ────────────────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2..."
  npm install -g pm2 -q
fi
success "PM2 $(pm2 -v)"

# ── Wine ───────────────────────────────────────────────────────────────────────
if ! command -v wine &>/dev/null; then
  info "Installing Wine (this takes a few minutes)..."
  dpkg --add-architecture i386
  mkdir -pm755 /etc/apt/keyrings
  curl -fsSL https://dl.winehq.org/wine-builds/winehq.key | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key
  add-apt-repository -y "deb [arch=amd64,i386 signed-by=/etc/apt/keyrings/winehq-archive.key] https://dl.winehq.org/wine-builds/ubuntu/ $(lsb_release -cs) main"
  apt-get update -qq
  apt-get install -y -qq --install-recommends winehq-stable
fi
success "Wine $(wine --version)"

# ── Winetricks ─────────────────────────────────────────────────────────────────
if ! command -v winetricks &>/dev/null; then
  info "Installing winetricks..."
  curl -fsSL https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks -o /usr/local/bin/winetricks
  chmod +x /usr/local/bin/winetricks
fi

# ── Directories ────────────────────────────────────────────────────────────────
mkdir -p /opt/copytrader/{instances,ea,logs}
success "Directories created"

# ── Download MT5 installer ─────────────────────────────────────────────────────
if [ ! -f /opt/copytrader/mt5setup.exe ]; then
  info "Downloading MT5 installer..."
  wget -q -O /opt/copytrader/mt5setup.exe "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe"
  success "MT5 installer downloaded"
else
  success "MT5 installer already present"
fi

# ════════════════════════════════════════════════════════════════════════════════
if [ "$MODE" = "agent" ]; then
# ════════════════════════════════════════════════════════════════════════════════

  echo ""
  info "Setting up VPS Agent (connects to Render web server)..."

  WEB_SERVER_URL="${WEB_SERVER_URL:-}"
  VPS_AGENT_SECRET="${VPS_AGENT_SECRET:-}"

  if [ -z "$WEB_SERVER_URL" ]; then
    echo -n "Enter your Render web server URL (e.g. https://my-app.onrender.com): "
    read WEB_SERVER_URL
  fi
  if [ -z "$VPS_AGENT_SECRET" ]; then
    echo -n "Enter your VPS_AGENT_SECRET (must match Render env variable): "
    read VPS_AGENT_SECRET
  fi

  # Install agent
  AGENT_DIR="/opt/copytrader/agent"
  mkdir -p "$AGENT_DIR"

  # Copy agent files (assumes they're in ./vps-agent/ relative to this script)
  if [ -d "$(dirname "$0")/vps-agent" ]; then
    cp -r "$(dirname "$0")/vps-agent/"* "$AGENT_DIR/"
  else
    warn "vps-agent/ folder not found next to setup script. Please copy agent.js and package.json manually to $AGENT_DIR"
  fi

  cat > "$AGENT_DIR/.env" << EOF
WEB_SERVER_URL=${WEB_SERVER_URL}
VPS_AGENT_SECRET=${VPS_AGENT_SECRET}
INSTANCES_DIR=/opt/copytrader/instances
MT5_INSTALLER=/opt/copytrader/mt5setup.exe
EA_SOURCE=/opt/copytrader/ea/CopyTrader_Cloud.ex5
POLL_INTERVAL=5000
EOF

  cd "$AGENT_DIR"
  npm install -q

  pm2 delete copytrader-agent 2>/dev/null || true
  pm2 start agent.js --name copytrader-agent --log /opt/copytrader/logs/agent.log
  pm2 save
  pm2 startup | tail -1 | bash 2>/dev/null || true

  echo ""
  success "✅ VPS Agent is running!"
  echo ""
  echo -e "${CYAN}Agent Status:${NC}"
  pm2 status copytrader-agent
  echo ""
  echo -e "${CYAN}Logs:${NC} pm2 logs copytrader-agent"
  echo -e "${CYAN}Web Server:${NC} ${WEB_SERVER_URL}"
  echo ""
  info "The agent will now pick up any pending accounts from your web server."

# ════════════════════════════════════════════════════════════════════════════════
elif [ "$MODE" = "full" ]; then
# ════════════════════════════════════════════════════════════════════════════════

  echo ""
  info "Setting up Full Stack (web server + MT5 on this VPS)..."

  WEB_DIR="/opt/copytrader/web"
  mkdir -p "$WEB_DIR"

  # Copy web-server files
  if [ -d "$(dirname "$0")/web-server" ]; then
    cp -r "$(dirname "$0")/web-server/"* "$WEB_DIR/"
  else
    warn "web-server/ folder not found. Please copy web-server/ to $WEB_DIR"
  fi

  # Generate secrets
  JWT_SECRET=$(openssl rand -hex 32)
  ENCRYPTION_SECRET=$(openssl rand -hex 32)
  VPS_AGENT_SECRET=$(openssl rand -hex 16)
  SERVER_URL="http://$(curl -s ifconfig.me):3000"

  cat > "$WEB_DIR/.env" << EOF
PORT=3000
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_SECRET=${ENCRYPTION_SECRET}
VPS_AGENT_SECRET=${VPS_AGENT_SECRET}
SERVER_URL=${SERVER_URL}
INSTANCES_DIR=/opt/copytrader/instances
MT5_INSTALLER=/opt/copytrader/mt5setup.exe
EA_SOURCE=/opt/copytrader/ea/CopyTrader_Cloud.ex5
DATA_DIR=/opt/copytrader/data
EOF

  # Agent .env
  AGENT_DIR="/opt/copytrader/agent"
  mkdir -p "$AGENT_DIR"
  if [ -d "$(dirname "$0")/vps-agent" ]; then
    cp -r "$(dirname "$0")/vps-agent/"* "$AGENT_DIR/"
  fi
  cat > "$AGENT_DIR/.env" << EOF
WEB_SERVER_URL=http://localhost:3000
VPS_AGENT_SECRET=${VPS_AGENT_SECRET}
INSTANCES_DIR=/opt/copytrader/instances
MT5_INSTALLER=/opt/copytrader/mt5setup.exe
EA_SOURCE=/opt/copytrader/ea/CopyTrader_Cloud.ex5
EOF

  mkdir -p /opt/copytrader/data

  cd "$WEB_DIR" && npm install -q
  cd "$AGENT_DIR" && npm install -q

  pm2 delete copytrader-web 2>/dev/null || true
  pm2 delete copytrader-agent 2>/dev/null || true
  pm2 start "$WEB_DIR/index.js" --name copytrader-web   --log /opt/copytrader/logs/web.log
  pm2 start "$AGENT_DIR/agent.js" --name copytrader-agent --log /opt/copytrader/logs/agent.log
  pm2 save
  pm2 startup | tail -1 | bash 2>/dev/null || true

  echo ""
  success "✅ Full stack is running!"
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════╗"
  echo -e "║  🚀 CopyTrader is LIVE                   ║"
  echo -e "║  URL: ${SERVER_URL}       ║"
  echo -e "╚══════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${CYAN}PM2 Status:${NC}"
  pm2 status
fi
