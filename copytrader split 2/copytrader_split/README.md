# ⚡ CopyTrader v4.1 — Split Architecture

## Two Ways to Deploy

### Option A — Preview Now (Web on Render, VPS Later)
Deploy just the web server to Render. Everything works — auth, channels, dashboard — but MT5 instances are "pending" until you connect a VPS.

### Option B — Full Stack on VPS (When Ready)
One command sets up everything (web + MT5) on a single VPS. No Render needed.

---

## Option A: Deploy Web Server to Render

### 1. Push to GitHub
```bash
git init && git add . && git commit -m "CopyTrader v4.1"
git push origin main
```

### 2. Deploy on Render
- Go to [render.com](https://render.com) → New → Web Service
- Connect your GitHub repo
- **Root directory:** `web-server`
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Add a Disk** → Mount path: `/data` → Size: 1 GB

### 3. Set Environment Variables on Render
| Variable | Value |
|---|---|
| `JWT_SECRET` | Any long random string |
| `ENCRYPTION_SECRET` | 32+ char random string |
| `VPS_AGENT_SECRET` | Choose a secret (you'll use this on VPS too) |
| `SERVER_URL` | `https://your-app.onrender.com` |
| `DATA_DIR` | `/data` |

### 4. Use the web app
Visit your Render URL. Create accounts, add MT5 credentials — they'll be queued as `AWAITING VPS`.

### 5. Connect VPS (when ready)
```bash
WEB_SERVER_URL=https://your-app.onrender.com \
VPS_AGENT_SECRET=your-secret \
bash setup_vps.sh agent
```

The VPS agent will pick up all pending accounts and launch MT5 automatically.

---

## Option B: Full Stack on VPS

```bash
# Ubuntu 22.04 VPS (4+ GB RAM recommended)
git clone https://github.com/YOUR_USERNAME/copytrader.git
cd copytrader
chmod +x setup_vps.sh
sudo bash setup_vps.sh full
# Visit http://YOUR_VPS_IP:3000
```

---

## Architecture

```
[Render Web Server]
    ├── User auth (JWT)
    ├── Channel management
    ├── Trade data store (SQLite)
    ├── MT5 EA push/pull API
    └── VPS Agent API
          ↕ poll every 5s
[VPS Agent]
    └── MT5 instances (Wine + Xvfb)
          ├── User 1: MT5 + EA (Master)  →  pushes trades to /api/master/push
          └── User 2: MT5 + EA (Slave)   →  pulls trades from /api/slave/trades
```

---

## Project Structure

```
copytrader/
├── web-server/          ← Deploy to Render (or VPS)
│   ├── index.js         ← Main server + VPS agent API
│   ├── crypto.js        ← AES-256-GCM credential encryption
│   ├── package.json
│   └── public/
│       └── index.html   ← Full web app SPA
├── vps-agent/           ← Runs on VPS only
│   ├── agent.js         ← Polls web server, manages MT5 instances
│   └── package.json
├── setup_vps.sh         ← One-command VPS setup (agent or full mode)
├── render.yaml          ← Render deployment config
└── README.md
```

---

## Environment Variables

### Web Server (Render)
| Variable | Description |
|---|---|
| `PORT` | HTTP port (Render sets automatically) |
| `JWT_SECRET` | JWT signing key |
| `ENCRYPTION_SECRET` | AES key for credential storage |
| `VPS_AGENT_SECRET` | Shared secret for VPS agent auth |
| `SERVER_URL` | Public URL of this server |
| `DATA_DIR` | Path to SQLite data directory |

### VPS Agent
| Variable | Description |
|---|---|
| `WEB_SERVER_URL` | URL of your Render web server |
| `VPS_AGENT_SECRET` | Must match the web server secret |
| `INSTANCES_DIR` | Where Wine prefixes are stored |
| `MT5_INSTALLER` | Path to mt5setup.exe |
| `EA_SOURCE` | Path to compiled CopyTrader_Cloud.ex5 |

---

## Scaling

| Users | RAM | Recommended |
|---|---|---|
| 1–10 | 4–6 GB | Hetzner CX31 |
| 10–30 | 8–12 GB | Hetzner CPX41 |
| 30+ | 16+ GB | Hetzner CCX33 |
