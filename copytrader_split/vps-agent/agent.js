/**
 * CopyTrader VPS Agent v4.1
 *
 * Runs on your Linux VPS. Polls the web server for pending MT5 accounts,
 * launches/stops MT5 instances via Wine, and reports status back.
 *
 * Required env:
 *   WEB_SERVER_URL   = https://your-app.onrender.com
 *   VPS_AGENT_SECRET = same secret set on the web server
 *
 * Optional env:
 *   INSTANCES_DIR    = /opt/copytrader/instances
 *   MT5_INSTALLER    = /opt/copytrader/mt5setup.exe
 *   EA_SOURCE        = /opt/copytrader/ea/CopyTrader_Cloud.ex5
 *   POLL_INTERVAL    = 5000  (ms)
 */

require('dotenv').config();

const { spawn, exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const util = require('util');
const execP = util.promisify(exec);

const WEB_SERVER_URL   = process.env.WEB_SERVER_URL   || 'http://localhost:3000';
const VPS_AGENT_SECRET = process.env.VPS_AGENT_SECRET || '';
const INSTANCES_DIR    = process.env.INSTANCES_DIR    || '/opt/copytrader/instances';
const MT5_INSTALLER    = process.env.MT5_INSTALLER    || '/opt/copytrader/mt5setup.exe';
const EA_SOURCE        = process.env.EA_SOURCE        || '/opt/copytrader/ea/CopyTrader_Cloud.ex5';
const POLL_INTERVAL    = parseInt(process.env.POLL_INTERVAL || '5000');

if (!VPS_AGENT_SECRET) {
  console.error('❌ VPS_AGENT_SECRET is required');
  process.exit(1);
}

const runningInstances = new Map(); // accountId → { pid, display, startedAt }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Web server API calls ───────────────────────────────────────────────────────
async function webApi(method, path, body) {
  const res = await fetch(`${WEB_SERVER_URL}/api${path}`, {
    method,
    headers: {
      'Content-Type':   'application/json',
      'x-agent-secret': VPS_AGENT_SECRET
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function reportStatus(accountId, status) {
  try {
    await webApi('POST', '/agent/status', { account_id: accountId, status });
  } catch (e) {
    console.warn(`[Agent] Failed to report status for ${accountId}:`, e.message);
  }
}

// ── MT5 instance management (same as original mt5manager.js) ──────────────────
function userDir(id)    { return path.join(INSTANCES_DIR, String(id)); }
function winePrefix(id) { return path.join(userDir(id), 'wine'); }
function displayNum(id) { return (parseInt(id) % 200) + 100; }
function display(id)    { return `:${displayNum(id)}`; }

async function startXvfb(id) {
  const disp = displayNum(id);
  try { await execP(`pkill -f "Xvfb :${disp}"`) } catch {}
  await sleep(500);
  return new Promise((resolve, reject) => {
    const xvfb = spawn('Xvfb', [`:${disp}`, '-screen', '0', '1024x768x16'], {
      detached: true, stdio: 'ignore'
    });
    xvfb.unref();
    setTimeout(() => resolve(xvfb), 1500);
    xvfb.on('error', reject);
  });
}

async function initWinePrefix(id) {
  const prefix = winePrefix(id);
  const marker = path.join(prefix, '.initialized');
  if (fs.existsSync(marker)) return;
  console.log(`[MT5] Initializing Wine prefix for account ${id}...`);
  const env = { ...process.env, WINEPREFIX: prefix, DISPLAY: display(id), WINEDEBUG: '-all' };
  await execP('wineboot --init', { env, timeout: 30000 });
  try { await execP('winetricks -q vcrun2019 corefonts', { env, timeout: 120000 }); } catch {}
  fs.writeFileSync(marker, Date.now().toString());
}

async function ensureMT5Installed(id) {
  const mt5Exe = path.join(winePrefix(id), 'drive_c/Program Files/MetaTrader 5/terminal64.exe');
  if (fs.existsSync(mt5Exe)) return;
  console.log(`[MT5] Installing MT5 for account ${id}...`);
  const env = { ...process.env, WINEPREFIX: winePrefix(id), DISPLAY: display(id), WINEDEBUG: '-all' };
  await execP(`wine "${MT5_INSTALLER}" /auto`, { env, timeout: 120000 });
}

async function writeMT5Config(id, creds) {
  const cfgDir = path.join(winePrefix(id), 'drive_c/Program Files/MetaTrader 5');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'terminal.ini'),
    `[Common]\nLogin=${creds.login}\nPassword=${creds.password}\nServer=${creds.server}\nAutoLogin=1\nNewsEnabled=0`
  );
}

async function deployEA(id, config) {
  const expertPath = path.join(winePrefix(id), 'drive_c/Program Files/MetaTrader 5/MQL5/Experts');
  fs.mkdirSync(expertPath, { recursive: true });
  if (fs.existsSync(EA_SOURCE)) fs.copyFileSync(EA_SOURCE, path.join(expertPath, 'CopyTrader_Cloud.ex5'));

  const setDir = path.join(winePrefix(id), 'drive_c/Program Files/MetaTrader 5/MQL5/Presets');
  fs.mkdirSync(setDir, { recursive: true });
  fs.writeFileSync(path.join(setDir, 'CopyTrader_Cloud.set'), `
[expert]
Mode=${config.mode === 'master' ? 0 : 1}
ServerURL=${WEB_SERVER_URL}
ChannelCode=${config.channel_code || ''}
MasterKey=${config.master_key || ''}
LotMode=${config.lot_mode_int || 0}
FixedLot=${config.fixed_lot || 0.01}
RiskPercent=${config.risk_pct || 1.0}
MasterBalance=${config.master_bal || 10000}
CopyStopLoss=1
CopyTakeProfit=1
InvertTrades=0
SlippagePts=30
CloseOnMasterClose=1
YourName=${config.user_name || ''}
MagicNumber=77001
PollSeconds=2`.trim());

  const cfgDir = path.join(winePrefix(id), 'drive_c/Program Files/MetaTrader 5');
  fs.writeFileSync(path.join(cfgDir, 'experts.ini'), `
[Experts]
AllowLiveTrading=1
AllowDllImport=0
Enabled=1
Account=0

[Chart0]
Symbol=EURUSD
Period=1
Expert=CopyTrader_Cloud
ExpertParameters=CopyTrader_Cloud.set`.trim());
}

async function launchInstance(accountId, account) {
  const id = String(accountId);
  if (runningInstances.has(id)) await stopInstance(accountId);

  console.log(`[MT5] Launching account ${id} (${account.server})`);

  fs.mkdirSync(winePrefix(id), { recursive: true });
  fs.mkdirSync(path.join(userDir(id), 'logs'), { recursive: true });

  await startXvfb(id);
  await initWinePrefix(id);
  await ensureMT5Installed(id);
  await writeMT5Config(id, { login: account.login, password: account.password, server: account.server });

  const lotModeMap = { MIRROR: 0, FIXED: 1, BALANCE: 2, RISK_PCT: 3 };
  await deployEA(id, {
    mode:          account.mode,
    channel_code:  account.channel_code,
    master_key:    account.master_key,
    lot_mode_int:  lotModeMap[account.lot_mode] || 0,
    fixed_lot:     account.fixed_lot,
    risk_pct:      account.risk_pct,
    master_bal:    account.master_bal,
    user_name:     account.user_name || account.user_email
  });

  const prefix  = winePrefix(id);
  const mt5Exe  = path.join(prefix, 'drive_c/Program Files/MetaTrader 5/terminal64.exe');
  const logFile = path.join(userDir(id), 'logs', 'mt5.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const env = { ...process.env, WINEPREFIX: prefix, DISPLAY: display(id), WINEDEBUG: '-all' };
  const proc = spawn('wine', [mt5Exe, '/portable'], {
    env, detached: true, stdio: ['ignore', logStream, logStream]
  });
  proc.unref();
  await sleep(5000);

  runningInstances.set(id, { pid: proc.pid, display: display(id), startedAt: Date.now() });
  console.log(`[MT5] Account ${id} running (PID: ${proc.pid})`);
  return proc.pid;
}

async function stopInstance(accountId) {
  const id   = String(accountId);
  const inst = runningInstances.get(id);
  if (!inst) return;

  try { await execP(`kill -TERM ${inst.pid}`); await sleep(2000); } catch {}
  try { await execP(`kill -9 ${inst.pid}`); } catch {}
  try { await execP(`wineserver -k`, { env: { ...process.env, WINEPREFIX: winePrefix(id) } }); } catch {}
  try { await execP(`pkill -f "Xvfb :${displayNum(id)}"`); } catch {}

  runningInstances.delete(id);
  console.log(`[MT5] Account ${id} stopped`);
}

// ── Health check ───────────────────────────────────────────────────────────────
async function healthCheck() {
  for (const [id, inst] of runningInstances.entries()) {
    try {
      await execP(`kill -0 ${inst.pid}`);
    } catch {
      console.warn(`[Agent] Account ${id} appears dead — marking error`);
      runningInstances.delete(id);
      await reportStatus(id, 'error');
    }
  }
}

// ── Main poll loop ─────────────────────────────────────────────────────────────
async function pollLoop() {
  console.log(`[Agent] Starting poll loop → ${WEB_SERVER_URL}`);

  while (true) {
    try {
      // Heartbeat
      await webApi('POST', '/agent/heartbeat', {});

      // Pick up pending launches
      const { accounts } = await webApi('GET', '/agent/pending', null);
      for (const account of accounts) {
        if (runningInstances.has(String(account.id))) continue; // already running
        await reportStatus(account.id, 'starting');
        try {
          await launchInstance(account.id, account);
          await reportStatus(account.id, 'running');
        } catch (e) {
          console.error(`[Agent] Failed to launch account ${account.id}:`, e.message);
          await reportStatus(account.id, 'error');
        }
      }

      // Process stop requests
      const { accounts: toStop } = await webApi('GET', '/agent/stop-queue', null);
      for (const { id } of toStop) {
        await stopInstance(id);
        await reportStatus(id, 'stopped');
      }

      await healthCheck();

    } catch (e) {
      console.error('[Agent] Poll error:', e.message);
    }

    await sleep(POLL_INTERVAL);
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('[Agent] Shutting down...');
  for (const id of runningInstances.keys()) await stopInstance(id);
  process.exit(0);
});

process.on('SIGINT', async () => {
  for (const id of runningInstances.keys()) await stopInstance(id);
  process.exit(0);
});

pollLoop();
