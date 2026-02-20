/**
 * mt5manager.js — Manages per-user MT5 instances
 *
 * Each user gets:
 *   - An isolated Wine prefix: /opt/copytrader/instances/{userId}/
 *   - A dedicated Xvfb display: :{userId % 200 + 100}
 *   - MT5 auto-logged in with their credentials
 *   - EA auto-copied and configured via MT5 ini file
 */

const { spawn, exec } = require('child_process');
const fs    = require('fs');
const path  = require('path');
const util  = require('util');
const execP = util.promisify(exec);
const { decrypt } = require('./crypto');

const INSTANCES_DIR = process.env.INSTANCES_DIR || '/opt/copytrader/instances';
const MT5_INSTALLER = process.env.MT5_INSTALLER  || '/opt/copytrader/mt5setup.exe';
const EA_SOURCE     = process.env.EA_SOURCE      || '/opt/copytrader/ea/CopyTrader_Cloud.ex5';
const SERVER_URL    = process.env.SERVER_URL      || 'http://localhost:3000';

// In-memory registry of running processes
const runningInstances = new Map(); // userId → { pid, display, winePrefix, startedAt }

// ── Helpers ───────────────────────────────────────────────────────────────────
function userDir(userId)     { return path.join(INSTANCES_DIR, String(userId)); }
function winePrefix(userId)  { return path.join(userDir(userId), 'wine'); }
function displayNum(userId)  { return (parseInt(userId) % 200) + 100; }
function display(userId)     { return `:${displayNum(userId)}`; }
function mt5DataDir(userId)  {
  return path.join(winePrefix(userId),
    'drive_c/Program Files/MetaTrader 5/MQL5');
}
function expertDir(userId)   { return path.join(mt5DataDir(userId), 'Experts'); }
function configDir(userId)   {
  return path.join(winePrefix(userId),
    'drive_c/users/user/Application Data/MetaQuotes/Terminal');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Status ────────────────────────────────────────────────────────────────────
function getStatus(userId) {
  const inst = runningInstances.get(String(userId));
  if (!inst) return { running: false };
  return {
    running:    true,
    pid:        inst.pid,
    display:    inst.display,
    startedAt:  inst.startedAt,
    uptime:     Math.floor((Date.now() - inst.startedAt) / 1000)
  };
}

function getAllStatuses() {
  const out = {};
  runningInstances.forEach((v, k) => {
    out[k] = { running: true, pid: v.pid, startedAt: v.startedAt };
  });
  return out;
}

// ── Launch MT5 instance ───────────────────────────────────────────────────────
async function launchInstance(userId, mt5Credentials, eaConfig) {
  const uid    = String(userId);
  const prefix = winePrefix(userId);
  const disp   = display(userId);

  // Stop existing instance if running
  if (runningInstances.has(uid)) {
    await stopInstance(userId);
    await sleep(2000);
  }

  console.log(`[MT5Manager] Launching instance for user ${uid} on display ${disp}`);

  // 1. Create directories
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(path.join(userDir(userId), 'logs'), { recursive: true });

  // 2. Start Xvfb virtual display
  await startXvfb(userId);

  // 3. Initialize Wine prefix if needed
  await initWinePrefix(userId);

  // 4. Install MT5 if not already installed in this prefix
  await ensureMT5Installed(userId);

  // 5. Write MT5 config (auto-login + broker server)
  await writeMT5Config(userId, mt5Credentials);

  // 6. Copy and configure EA
  await deployEA(userId, eaConfig);

  // 7. Launch MT5
  const proc = await startMT5Process(userId);

  runningInstances.set(uid, {
    pid:       proc.pid,
    display:   disp,
    startedAt: Date.now(),
    userId:    uid
  });

  console.log(`[MT5Manager] Instance started for user ${uid} (PID: ${proc.pid})`);
  return { ok: true, pid: proc.pid, display: disp };
}

// ── Xvfb ──────────────────────────────────────────────────────────────────────
async function startXvfb(userId) {
  const disp = displayNum(userId);
  // Kill any stale Xvfb on this display
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

// ── Wine prefix init ──────────────────────────────────────────────────────────
async function initWinePrefix(userId) {
  const prefix = winePrefix(userId);
  const marker = path.join(prefix, '.initialized');
  if (fs.existsSync(marker)) return;

  console.log(`[MT5Manager] Initializing Wine prefix for user ${userId}...`);
  const env = { ...process.env, WINEPREFIX: prefix, DISPLAY: display(userId), WINEDEBUG: '-all' };

  await execP('wineboot --init', { env, timeout: 30000 });
  // Install required Windows components
  try {
    await execP(`winetricks -q vcrun2019 corefonts`, { env, timeout: 120000 });
  } catch (e) {
    console.warn(`[MT5Manager] winetricks warning (non-fatal): ${e.message}`);
  }
  fs.writeFileSync(marker, Date.now().toString());
  console.log(`[MT5Manager] Wine prefix ready for user ${userId}`);
}

// ── MT5 install ───────────────────────────────────────────────────────────────
async function ensureMT5Installed(userId) {
  const prefix   = winePrefix(userId);
  const mt5Exe   = path.join(prefix, 'drive_c/Program Files/MetaTrader 5/terminal64.exe');
  if (fs.existsSync(mt5Exe)) return;

  console.log(`[MT5Manager] Installing MT5 for user ${userId}...`);
  const env = { ...process.env, WINEPREFIX: prefix, DISPLAY: display(userId), WINEDEBUG: '-all' };
  // Silent install
  await execP(`wine "${MT5_INSTALLER}" /auto`, { env, timeout: 120000 });
  console.log(`[MT5Manager] MT5 installed for user ${userId}`);
}

// ── MT5 config (auto-login) ───────────────────────────────────────────────────
async function writeMT5Config(userId, creds) {
  // MT5 reads login from terminal.ini on startup
  // Find the terminal data folder (created after first MT5 run)
  const prefix = winePrefix(userId);
  const appdata = path.join(prefix, 'drive_c/users/user/AppData/Roaming/MetaQuotes/Terminal');

  // Write to the common config location
  const commonCfg = path.join(prefix, 'drive_c/Program Files/MetaTrader 5');
  fs.mkdirSync(commonCfg, { recursive: true });

  const ini = `
[Common]
Login=${creds.login}
Password=${creds.password}
Server=${creds.server}
AutoLogin=1
NewsEnabled=0
`.trim();

  fs.writeFileSync(path.join(commonCfg, 'terminal.ini'), ini);
}

// ── EA deployment ─────────────────────────────────────────────────────────────
async function deployEA(userId, config) {
  // EA goes into the Experts folder
  const expertPath = path.join(
    winePrefix(userId),
    'drive_c/Program Files/MetaTrader 5/MQL5/Experts'
  );
  fs.mkdirSync(expertPath, { recursive: true });

  // Copy compiled EA (.ex5) into experts folder
  if (fs.existsSync(EA_SOURCE)) {
    fs.copyFileSync(EA_SOURCE, path.join(expertPath, 'CopyTrader_Cloud.ex5'));
  }

  // Write EA config as .set file so it auto-loads with the right settings
  const setContent = buildEASetFile(config);
  const setDir = path.join(
    winePrefix(userId),
    'drive_c/Program Files/MetaTrader 5/MQL5/Presets'
  );
  fs.mkdirSync(setDir, { recursive: true });
  fs.writeFileSync(path.join(setDir, 'CopyTrader_Cloud.set'), setContent);

  // Write expert.ini to auto-attach EA to EURUSD M1 on startup
  const cfgDir = path.join(
    winePrefix(userId),
    'drive_c/Program Files/MetaTrader 5'
  );
  const expertIni = buildExpertIni(config);
  fs.writeFileSync(path.join(cfgDir, 'experts.ini'), expertIni);
}

function buildEASetFile(config) {
  return `
[expert]
Mode=${config.mode === 'master' ? 0 : 1}
ServerURL=${SERVER_URL}
ChannelCode=${config.channelCode}
MasterKey=${config.masterKey || ''}
LotMode=${config.lotMode || 0}
FixedLot=${config.fixedLot || 0.01}
RiskPercent=${config.riskPercent || 1.0}
MasterBalance=${config.masterBalance || 10000}
CopyStopLoss=${config.copyStopLoss !== false ? 1 : 0}
CopyTakeProfit=${config.copyTakeProfit !== false ? 1 : 0}
InvertTrades=${config.invertTrades ? 1 : 0}
SlippagePts=${config.slippagePts || 30}
CloseOnMasterClose=${config.closeOnMasterClose !== false ? 1 : 0}
YourName=${config.userName || ''}
MagicNumber=77001
PollSeconds=2
`.trim();
}

function buildExpertIni(config) {
  // This tells MT5 to auto-attach our EA to a chart on startup
  return `
[Experts]
AllowLiveTrading=1
AllowDllImport=0
Enabled=1
Account=0

[Chart0]
Symbol=EURUSD
Period=1
Expert=CopyTrader_Cloud
ExpertParameters=CopyTrader_Cloud.set
`.trim();
}

// ── Start MT5 process ─────────────────────────────────────────────────────────
async function startMT5Process(userId) {
  const prefix = winePrefix(userId);
  const mt5Exe = path.join(prefix, 'drive_c/Program Files/MetaTrader 5/terminal64.exe');
  const logFile = path.join(userDir(userId), 'logs', 'mt5.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const env = {
    ...process.env,
    WINEPREFIX: prefix,
    DISPLAY:    display(userId),
    WINEDEBUG:  '-all'
  };

  const proc = spawn('wine', [mt5Exe, '/portable'], {
    env, detached: true,
    stdio: ['ignore', logStream, logStream]
  });
  proc.unref();

  // Give MT5 time to start and log in
  await sleep(5000);
  return proc;
}

// ── Stop instance ─────────────────────────────────────────────────────────────
async function stopInstance(userId) {
  const uid  = String(userId);
  const inst = runningInstances.get(uid);

  if (inst) {
    try {
      // Graceful kill of MT5 wine process tree
      await execP(`kill -TERM ${inst.pid}`);
      await sleep(2000);
      await execP(`kill -9 ${inst.pid}`).catch(() => {});
    } catch {}

    // Kill Wine processes for this prefix
    const prefix = winePrefix(userId);
    try {
      await execP(`wineserver -k`, {
        env: { ...process.env, WINEPREFIX: prefix }
      });
    } catch {}

    // Kill Xvfb
    try {
      await execP(`pkill -f "Xvfb :${displayNum(userId)}"`);
    } catch {}

    runningInstances.delete(uid);
    console.log(`[MT5Manager] Stopped instance for user ${uid}`);
  }
}

// ── Restart instance (e.g. after config change) ───────────────────────────────
async function restartInstance(userId, mt5Credentials, eaConfig) {
  await stopInstance(userId);
  await sleep(2000);
  return launchInstance(userId, mt5Credentials, eaConfig);
}

// ── Health check — ping all instances ────────────────────────────────────────
async function healthCheck() {
  for (const [uid, inst] of runningInstances.entries()) {
    try {
      await execP(`kill -0 ${inst.pid}`); // just checks if process exists
    } catch {
      console.warn(`[MT5Manager] Instance for user ${uid} appears dead — removing`);
      runningInstances.delete(uid);
    }
  }
}

// Run health check every 30s
setInterval(healthCheck, 30_000);

module.exports = {
  launchInstance,
  stopInstance,
  restartInstance,
  getStatus,
  getAllStatuses,
  runningInstances
};
