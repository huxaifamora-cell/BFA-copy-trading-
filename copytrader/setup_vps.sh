#!/bin/bash
# CopyTrader v4 — Full VPS Setup
# Tested on Ubuntu 22.04 LTS
# Run as root: bash setup_vps.sh

set -e
CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'

INSTALL_DIR="/opt/copytrader"
APP_DIR="$INSTALL_DIR/app"
INSTANCES_DIR="$INSTALL_DIR/instances"
MT5_INSTALLER="$INSTALL_DIR/mt5setup.exe"
EA_DIR="$INSTALL_DIR/ea"

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║       CopyTrader v4 — VPS Setup Script              ║"
echo "║       Ubuntu 22.04 LTS                               ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── 1. System update ──────────────────────────────────────────────────────────
echo -e "${BOLD}[1/9] Updating system...${NC}"
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget unzip software-properties-common gnupg2 ca-certificates
echo -e "${GREEN}✅ System updated${NC}"

# ── 2. Node.js 20 ────────────────────────────────────────────────────────────
echo -e "${BOLD}[2/9] Installing Node.js 20...${NC}"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo -e "${GREEN}✅ Node.js $(node --version)${NC}"

# ── 3. PM2 ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}[3/9] Installing PM2...${NC}"
npm install -g pm2 --silent
echo -e "${GREEN}✅ PM2 $(pm2 --version)${NC}"

# ── 4. Wine + Xvfb ───────────────────────────────────────────────────────────
echo -e "${BOLD}[4/9] Installing Wine and Xvfb...${NC}"
dpkg --add-architecture i386
mkdir -pm755 /etc/apt/keyrings
curl -fsSL https://dl.winehq.org/wine-builds/winehq.key | \
  gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key
echo "deb [arch=amd64,i386 signed-by=/etc/apt/keyrings/winehq-archive.key] \
https://dl.winehq.org/wine-builds/ubuntu/ jammy main" \
  > /etc/apt/sources.list.d/winehq.list
apt-get update -qq
apt-get install -y --install-recommends winehq-stable
apt-get install -y xvfb x11-utils winetricks
echo -e "${GREEN}✅ Wine $(wine --version) + Xvfb installed${NC}"

# ── 5. Create directories ─────────────────────────────────────────────────────
echo -e "${BOLD}[5/9] Creating directory structure...${NC}"
mkdir -p "$INSTALL_DIR" "$APP_DIR" "$INSTANCES_DIR" "$EA_DIR"
echo -e "${GREEN}✅ Directories created at $INSTALL_DIR${NC}"

# ── 6. Download MT5 installer ─────────────────────────────────────────────────
echo -e "${BOLD}[6/9] Downloading MetaTrader 5...${NC}"
if [ ! -f "$MT5_INSTALLER" ]; then
  wget -q --show-progress \
    "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe" \
    -O "$MT5_INSTALLER"
  echo -e "${GREEN}✅ MT5 installer downloaded${NC}"
else
  echo -e "${YELLOW}⚡ MT5 installer already present — skipping${NC}"
fi

# ── 7. Copy app files ─────────────────────────────────────────────────────────
echo -e "${BOLD}[7/9] Installing application files...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -r "$SCRIPT_DIR/server/." "$APP_DIR/"
mkdir -p "$APP_DIR/data" "$APP_DIR/public"

# Generate secrets if .env doesn't exist
if [ ! -f "$APP_DIR/.env" ]; then
  ENCRYPTION_SECRET=$(openssl rand -hex 32)
  JWT_SECRET=$(openssl rand -hex 32)
  cat > "$APP_DIR/.env" <<EOF
PORT=3000
ENCRYPTION_SECRET=${ENCRYPTION_SECRET}
JWT_SECRET=${JWT_SECRET}
INSTANCES_DIR=${INSTANCES_DIR}
MT5_INSTALLER=${MT5_INSTALLER}
EA_SOURCE=${EA_DIR}/CopyTrader_Cloud.ex5
SERVER_URL=http://localhost:3000
EOF
  echo -e "${GREEN}✅ .env generated with random secrets${NC}"
else
  echo -e "${YELLOW}⚡ .env already exists — keeping existing secrets${NC}"
fi

# Install npm dependencies
cd "$APP_DIR"
npm install --silent
echo -e "${GREEN}✅ App files installed${NC}"

# ── 8. Firewall ───────────────────────────────────────────────────────────────
echo -e "${BOLD}[8/9] Configuring firewall...${NC}"
ufw allow 22/tcp  2>/dev/null || true
ufw allow 3000/tcp 2>/dev/null || true
ufw --force enable 2>/dev/null || true
echo -e "${GREEN}✅ Firewall configured (ports 22, 3000)${NC}"

# ── 9. Start with PM2 ────────────────────────────────────────────────────────
echo -e "${BOLD}[9/9] Starting application...${NC}"
pm2 stop copytrader 2>/dev/null || true
pm2 delete copytrader 2>/dev/null || true
pm2 start "$APP_DIR/index.js" --name copytrader \
  --env production \
  --log "$INSTALL_DIR/logs/app.log" \
  --time
pm2 save
pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || true
mkdir -p "$INSTALL_DIR/logs"

PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_SERVER_IP")

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║            ✅ SETUP COMPLETE!                        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e " 🌐 Website:  ${BOLD}http://${PUBLIC_IP}:3000${NC}"
echo ""
echo -e " 📋 Next steps:"
echo -e "   1. Open the website and create an account"
echo -e "   2. Click 'Add Account' and enter your MT5 credentials"
echo -e "   3. Choose Master or Follower — the server handles the rest"
echo ""
echo -e " ⚙️  PM2 commands:"
echo -e "   pm2 status             — check if running"
echo -e "   pm2 logs copytrader    — view live logs"
echo -e "   pm2 restart copytrader — restart after code changes"
echo ""
echo -e " 🔑 Secrets stored in: ${BOLD}$APP_DIR/.env${NC}"
echo -e "    Never share this file!"
echo ""
echo -e " 💡 To use a domain + HTTPS, install nginx and certbot:"
echo -e "    apt install nginx certbot python3-certbot-nginx"
echo ""
