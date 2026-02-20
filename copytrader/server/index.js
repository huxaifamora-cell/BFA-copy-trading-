/**
 * CopyTrader Cloud v4 — Main Server
 * User auth + MT5 instance management + Trade relay API
 */

require('dotenv').config();

const express    = require('express');
const sqlite3    = require('sqlite3').verbose();
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const fs         = require('fs');
const { encrypt, decrypt } = require('./crypto');
const mt5        = require('./mt5manager');

const app     = express();
const PORT    = process.env.PORT    || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = path.join(__dirname, 'data', 'trades.db');

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const apiLimiter   = rateLimit({ windowMs: 60_000, max: 300 });
const authLimiter  = rateLimit({ windowMs: 60_000, max: 10, message: { error: 'Too many attempts' } });
app.use('/api/', apiLimiter);

// ── Database ──────────────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));

const db = new sqlite3.Database(DB_PATH, err => {
  if (err) { console.error('DB Error:', err); process.exit(1); }
  console.log('✅ Database connected');
});

db.serialize(() => {
  db.run(`PRAGMA journal_mode=WAL`);

  // Users
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT UNIQUE NOT NULL,
    password     TEXT NOT NULL,
    name         TEXT DEFAULT '',
    created_at   INTEGER DEFAULT (strftime('%s','now')),
    last_login   INTEGER DEFAULT 0
  )`);

  // MT5 accounts linked to users (credentials encrypted)
  db.run(`CREATE TABLE IF NOT EXISTS mt5_accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    label        TEXT DEFAULT 'My Account',
    login_enc    TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    server       TEXT NOT NULL,
    account_type TEXT DEFAULT 'demo',
    mode         TEXT DEFAULT 'slave',
    channel_code TEXT DEFAULT '',
    master_key   TEXT DEFAULT '',
    lot_mode     TEXT DEFAULT 'MIRROR',
    fixed_lot    REAL DEFAULT 0.01,
    risk_pct     REAL DEFAULT 1.0,
    master_bal   REAL DEFAULT 10000,
    status       TEXT DEFAULT 'stopped',
    last_active  INTEGER DEFAULT 0,
    created_at   INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // Channels
  db.run(`CREATE TABLE IF NOT EXISTS channels (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT UNIQUE NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    owner_id     INTEGER NOT NULL,
    master_key   TEXT NOT NULL,
    require_sub  INTEGER DEFAULT 1,
    created_at   INTEGER DEFAULT (strftime('%s','now')),
    last_active  INTEGER DEFAULT 0
  )`);

  // Live trades
  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel     TEXT NOT NULL,
    ticket      INTEGER NOT NULL,
    symbol      TEXT NOT NULL,
    type        INTEGER NOT NULL,
    lots        REAL NOT NULL,
    open_price  REAL NOT NULL,
    sl          REAL DEFAULT 0,
    tp          REAL DEFAULT 0,
    open_time   INTEGER NOT NULL,
    profit      REAL DEFAULT 0,
    updated_at  INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(channel, ticket)
  )`);

  // Trade history
  db.run(`CREATE TABLE IF NOT EXISTS trade_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel     TEXT NOT NULL,
    ticket      INTEGER NOT NULL,
    symbol      TEXT NOT NULL,
    type        INTEGER NOT NULL,
    lots        REAL NOT NULL,
    open_price  REAL NOT NULL,
    close_price REAL NOT NULL,
    sl          REAL DEFAULT 0,
    tp          REAL DEFAULT 0,
    open_time   INTEGER NOT NULL,
    close_time  INTEGER NOT NULL,
    profit      REAL DEFAULT 0,
    pips        REAL DEFAULT 0,
    UNIQUE(channel, ticket)
  )`);

  // Subscriptions
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    channel       TEXT NOT NULL,
    slave_id      TEXT NOT NULL,
    name          TEXT DEFAULT '',
    status        TEXT DEFAULT 'pending',
    lot_mode      TEXT DEFAULT 'MIRROR',
    last_seen     INTEGER DEFAULT 0,
    requested_at  INTEGER DEFAULT (strftime('%s','now')),
    approved_at   INTEGER DEFAULT 0,
    UNIQUE(channel, slave_id)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_trades_channel  ON trades(channel)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_history_channel ON trade_history(channel)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_subs_channel    ON subscriptions(channel)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mt5_user        ON mt5_accounts(user_id)`);
  console.log('✅ Schema ready');
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
const now   = () => Math.floor(Date.now() / 1000);

function genCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len)).map(b => chars[b % chars.length]).join('');
}

function calcStats(history) {
  if (!history || !history.length)
    return { total:0, wins:0, losses:0, winRate:0, totalProfit:0, totalPips:0, bestTrade:0, worstTrade:0, avgProfit:0 };
  const wins = history.filter(t => t.profit > 0);
  const profits = history.map(t => t.profit);
  return {
    total:       history.length,
    wins:        wins.length,
    losses:      history.length - wins.length,
    winRate:     Math.round((wins.length / history.length) * 100),
    totalProfit: +history.reduce((s, t) => s + t.profit, 0).toFixed(2),
    totalPips:   +history.reduce((s, t) => s + (t.pips || 0), 0).toFixed(1),
    bestTrade:   +Math.max(...profits).toFixed(2),
    worstTrade:  +Math.min(...profits).toFixed(2),
    avgProfit:   +(history.reduce((s, t) => s + t.profit, 0) / history.length).toFixed(2)
  };
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/auth/signup
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const { email, password, name = '' } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = await dbGet(`SELECT id FROM users WHERE email = ?`, [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 12);
    const result = await dbRun(
      `INSERT INTO users (email, password, name) VALUES (?, ?, ?)`,
      [email.toLowerCase(), hashed, name]
    );

    const token = jwt.sign({ id: result.lastID, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: result.lastID, email: email.toLowerCase(), name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await dbGet(`SELECT * FROM users WHERE email = ?`, [email?.toLowerCase()]);
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Invalid email or password' });

    await dbRun(`UPDATE users SET last_login = ? WHERE id = ?`, [now(), user.id]);
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await dbGet(`SELECT id, email, name, created_at, last_login FROM users WHERE id = ?`, [req.user.id]);
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  MT5 ACCOUNT ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/mt5/connect  — user adds their MT5 credentials
app.post('/api/mt5/connect', requireAuth, async (req, res) => {
  try {
    const {
      label = 'My Account', login, password, server,
      account_type = 'demo', mode = 'slave',
      channel_code = '', master_key = '',
      lot_mode = 'MIRROR', fixed_lot = 0.01,
      risk_pct = 1.0, master_bal = 10000
    } = req.body;

    if (!login || !password || !server)
      return res.status(400).json({ error: 'Login, password, and server are required' });

    // Encrypt credentials before storing
    const login_enc    = encrypt(String(login));
    const password_enc = encrypt(String(password));

    const result = await dbRun(
      `INSERT INTO mt5_accounts
         (user_id, label, login_enc, password_enc, server, account_type,
          mode, channel_code, master_key, lot_mode, fixed_lot, risk_pct, master_bal)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.user.id, label, login_enc, password_enc, server, account_type,
       mode, channel_code.toUpperCase(), master_key, lot_mode, fixed_lot, risk_pct, master_bal]
    );

    const accountId = result.lastID;

    // Auto-create channel if mode is master
    let channelInfo = null;
    if (mode === 'master') {
      const code      = genCode(6);
      const mKey      = genCode(16);
      await dbRun(
        `INSERT INTO channels (code, name, description, owner_id, master_key) VALUES (?,?,?,?,?)`,
        [code, `${label}'s Channel`, '', req.user.id, mKey]
      );
      await dbRun(`UPDATE mt5_accounts SET channel_code=?, master_key=? WHERE id=?`, [code, mKey, accountId]);
      channelInfo = { code, master_key: mKey };
    }

    // Launch MT5 instance
    const creds = { login: String(login), password: String(password), server };
    const eaConfig = {
      mode, channelCode: channelInfo?.code || channel_code,
      masterKey: channelInfo?.master_key || master_key,
      lotMode: lotModeInt(lot_mode), fixedLot: fixed_lot,
      riskPercent: risk_pct, masterBalance: master_bal,
      userName: req.user.name || req.user.email
    };

    // Launch async — don't block the response
    mt5.launchInstance(accountId, creds, eaConfig)
      .then(() => dbRun(`UPDATE mt5_accounts SET status='running', last_active=? WHERE id=?`, [now(), accountId]))
      .catch(async err => {
        console.error(`[MT5] Launch failed for account ${accountId}:`, err.message);
        await dbRun(`UPDATE mt5_accounts SET status='error' WHERE id=?`, [accountId]);
      });

    await dbRun(`UPDATE mt5_accounts SET status='starting' WHERE id=?`, [accountId]);

    res.json({
      ok: true, accountId,
      status: 'starting',
      message: 'MT5 instance launching — takes 30-60 seconds',
      channel: channelInfo
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/mt5/accounts  — list user's MT5 accounts
app.get('/api/mt5/accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await dbAll(
      `SELECT id, label, server, account_type, mode, channel_code,
              lot_mode, fixed_lot, risk_pct, master_bal,
              status, last_active, created_at
       FROM mt5_accounts WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
    // Add runtime status
    accounts.forEach(a => {
      const rt = mt5.getStatus(a.id);
      a.running = rt.running;
      a.uptime  = rt.uptime || 0;
    });
    res.json(accounts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/mt5/accounts/:id/status
app.get('/api/mt5/accounts/:id/status', requireAuth, async (req, res) => {
  try {
    const account = await dbGet(`SELECT * FROM mt5_accounts WHERE id=? AND user_id=?`,
      [req.params.id, req.user.id]);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const rt = mt5.getStatus(account.id);
    res.json({ ...rt, db_status: account.status, last_active: account.last_active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/mt5/accounts/:id/start
app.post('/api/mt5/accounts/:id/start', requireAuth, async (req, res) => {
  try {
    const account = await dbGet(`SELECT * FROM mt5_accounts WHERE id=? AND user_id=?`,
      [req.params.id, req.user.id]);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const creds = {
      login:    decrypt(account.login_enc),
      password: decrypt(account.password_enc),
      server:   account.server
    };
    const eaConfig = {
      mode:          account.mode,
      channelCode:   account.channel_code,
      masterKey:     account.master_key,
      lotMode:       lotModeInt(account.lot_mode),
      fixedLot:      account.fixed_lot,
      riskPercent:   account.risk_pct,
      masterBalance: account.master_bal,
      userName:      req.user.name || req.user.email
    };

    await dbRun(`UPDATE mt5_accounts SET status='starting' WHERE id=?`, [account.id]);
    mt5.launchInstance(account.id, creds, eaConfig)
      .then(() => dbRun(`UPDATE mt5_accounts SET status='running', last_active=? WHERE id=?`, [now(), account.id]))
      .catch(async err => {
        console.error(`[MT5] Restart failed for ${account.id}:`, err.message);
        await dbRun(`UPDATE mt5_accounts SET status='error' WHERE id=?`, [account.id]);
      });

    res.json({ ok: true, message: 'MT5 instance starting...' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/mt5/accounts/:id/stop
app.post('/api/mt5/accounts/:id/stop', requireAuth, async (req, res) => {
  try {
    const account = await dbGet(`SELECT id FROM mt5_accounts WHERE id=? AND user_id=?`,
      [req.params.id, req.user.id]);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    await mt5.stopInstance(account.id);
    await dbRun(`UPDATE mt5_accounts SET status='stopped' WHERE id=?`, [account.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/mt5/accounts/:id
app.delete('/api/mt5/accounts/:id', requireAuth, async (req, res) => {
  try {
    const account = await dbGet(`SELECT id FROM mt5_accounts WHERE id=? AND user_id=?`,
      [req.params.id, req.user.id]);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    await mt5.stopInstance(account.id);
    await dbRun(`DELETE FROM mt5_accounts WHERE id=?`, [account.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function lotModeInt(str) {
  return { MIRROR: 0, FIXED: 1, BALANCE: 2, RISK_PCT: 3 }[str] || 0;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CHANNEL ROUTES  (same as v3)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/channels/:code', async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT code,name,description,require_sub,created_at,last_active FROM channels WHERE code=?`,
      [req.params.code.toUpperCase()]
    );
    if (!row) return res.status(404).json({ error: 'Channel not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/channels/:code/settings', requireAuth, async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const { name, description, require_sub } = req.body;
    const ch = await dbGet(`SELECT * FROM channels WHERE code=? AND owner_id=?`, [code, req.user.id]);
    if (!ch) return res.status(403).json({ error: 'Not authorised' });
    await dbRun(`UPDATE channels SET name=?,description=?,require_sub=? WHERE code=?`,
      [name || ch.name, description ?? ch.description, require_sub ? 1 : 0, code]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  MASTER PUSH  (called by EA running on server)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/master/push', async (req, res) => {
  try {
    const { code, master_key, trades = [], closed = [] } = req.body;
    const ch = await dbGet(`SELECT * FROM channels WHERE code=? AND master_key=?`,
      [code?.toUpperCase(), master_key]);
    if (!ch) return res.status(403).json({ error: 'Invalid credentials' });

    const ts = now();

    for (const t of closed) {
      await dbRun(
        `INSERT OR IGNORE INTO trade_history
           (channel,ticket,symbol,type,lots,open_price,close_price,sl,tp,open_time,close_time,profit,pips)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [code, t.ticket, t.symbol, t.type, t.lots, t.open_price,
         t.close_price || t.open_price, t.sl||0, t.tp||0,
         t.open_time, t.close_time||ts, t.profit||0, t.pips||0]
      );
      await dbRun(`DELETE FROM trades WHERE channel=? AND ticket=?`, [code, t.ticket]);
    }

    const tickets = trades.map(t => t.ticket);
    if (tickets.length > 0) {
      await dbRun(
        `DELETE FROM trades WHERE channel=? AND ticket NOT IN (${tickets.map(() => '?').join(',')})`,
        [code, ...tickets]
      );
    } else {
      await dbRun(`DELETE FROM trades WHERE channel=?`, [code]);
    }

    for (const t of trades) {
      await dbRun(
        `INSERT INTO trades (channel,ticket,symbol,type,lots,open_price,sl,tp,open_time,profit,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(channel,ticket) DO UPDATE SET
           lots=excluded.lots,sl=excluded.sl,tp=excluded.tp,
           profit=excluded.profit,updated_at=excluded.updated_at`,
        [code, t.ticket, t.symbol, t.type, t.lots, t.open_price,
         t.sl||0, t.tp||0, t.open_time, t.profit||0, ts]
      );
    }

    await dbRun(`UPDATE channels SET last_active=? WHERE code=?`, [ts, code]);
    res.json({ ok: true, ts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  SLAVE FETCH  (called by EA running on server)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/slave/trades/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const { slave_id = 'unknown', lot_mode = 'MIRROR' } = req.query;
    const ts = now();

    const ch = await dbGet(`SELECT * FROM channels WHERE code=?`, [code]);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });

    if (ch.require_sub) {
      const sub = await dbGet(`SELECT status FROM subscriptions WHERE channel=? AND slave_id=?`, [code, slave_id]);
      if (!sub)                   return res.status(403).json({ error: 'not_subscribed' });
      if (sub.status !== 'approved') return res.status(403).json({ error: sub.status });
    }

    await dbRun(
      `INSERT INTO subscriptions (channel,slave_id,lot_mode,status,last_seen) VALUES (?,?,?,'approved',?)
       ON CONFLICT(channel,slave_id) DO UPDATE SET last_seen=excluded.last_seen,lot_mode=excluded.lot_mode`,
      [code, slave_id, lot_mode, ts]
    );

    const trades = await dbAll(`SELECT * FROM trades WHERE channel=? ORDER BY open_time ASC`, [code]);
    const stale  = ts - ch.last_active > 30;
    res.json({ ok: true, channel: code, stale, timestamp: ts, trades });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  SUBSCRIPTIONS
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/subscribe', async (req, res) => {
  try {
    const { code, slave_id, name = '', lot_mode = 'MIRROR' } = req.body;
    const ch = await dbGet(`SELECT * FROM channels WHERE code=?`, [code?.toUpperCase()]);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    const status = ch.require_sub ? 'pending' : 'approved';
    await dbRun(
      `INSERT INTO subscriptions (channel,slave_id,name,lot_mode,status,last_seen)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(channel,slave_id) DO UPDATE SET
         name=excluded.name, lot_mode=excluded.lot_mode, last_seen=excluded.last_seen`,
      [code, slave_id, name, lot_mode, status, now()]
    );
    const sub = await dbGet(`SELECT status FROM subscriptions WHERE channel=? AND slave_id=?`, [code, slave_id]);
    res.json({ ok: true, status: sub.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/subscriptions/:id', requireAuth, async (req, res) => {
  try {
    const { action } = req.body;
    if (!['approve','reject','revoke'].includes(action))
      return res.status(400).json({ error: 'Invalid action' });
    const sub = await dbGet(`SELECT s.*, c.owner_id FROM subscriptions s
      JOIN channels c ON c.code = s.channel WHERE s.id=?`, [req.params.id]);
    if (!sub || sub.owner_id !== req.user.id)
      return res.status(403).json({ error: 'Not authorised' });
    const status      = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'revoked';
    const approved_at = action === 'approve' ? now() : 0;
    await dbRun(`UPDATE subscriptions SET status=?,approved_at=? WHERE id=?`, [status, approved_at, req.params.id]);
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  DASHBOARD / PUBLIC
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/dashboard', async (req, res) => {
  try {
    const channels = await dbAll(`
      SELECT c.code, c.name, c.description, c.require_sub, c.created_at, c.last_active,
             COUNT(DISTINCT t.id) as open_trades,
             (SELECT COUNT(*) FROM trade_history WHERE channel=c.code) as closed_trades,
             COALESCE(SUM(t.profit),0) as live_profit,
             COALESCE((SELECT SUM(profit) FROM trade_history WHERE channel=c.code),0) as history_profit
      FROM channels c LEFT JOIN trades t ON t.channel=c.code
      GROUP BY c.code ORDER BY c.last_active DESC`);
    res.json({ channels, server_time: now() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const ch   = await dbGet(`SELECT code,name,description,require_sub,created_at,last_active FROM channels WHERE code=?`, [code]);
    if (!ch) return res.status(404).json({ error: 'Not found' });

    const [trades, history, activeSubs] = await Promise.all([
      dbAll(`SELECT * FROM trades WHERE channel=? ORDER BY open_time DESC`, [code]),
      dbAll(`SELECT * FROM trade_history WHERE channel=? ORDER BY close_time DESC LIMIT 500`, [code]),
      dbAll(`SELECT slave_id,last_seen,lot_mode FROM subscriptions WHERE channel=? AND status='approved' AND last_seen>?`,
        [code, now()-300])
    ]);

    res.json({ channel: ch, trades, history, stats: calcStats(history), active_slaves: activeSubs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// User's own channels + accounts
app.get('/api/user/overview', requireAuth, async (req, res) => {
  try {
    const [accounts, channels] = await Promise.all([
      dbAll(`SELECT id,label,server,account_type,mode,channel_code,status,last_active
             FROM mt5_accounts WHERE user_id=? ORDER BY created_at DESC`, [req.user.id]),
      dbAll(`SELECT c.code,c.name,c.require_sub,c.last_active,
                    COUNT(DISTINCT t.id) as open_trades,
                    COUNT(DISTINCT s.id) as pending_subs
             FROM channels c
             LEFT JOIN trades t ON t.channel=c.code
             LEFT JOIN subscriptions s ON s.channel=c.code AND s.status='pending'
             WHERE c.owner_id=? GROUP BY c.code`, [req.user.id])
    ]);
    accounts.forEach(a => {
      const rt = mt5.getStatus(a.id);
      a.running = rt.running;
      a.uptime  = rt.uptime || 0;
    });
    res.json({ accounts, channels });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`\n🚀 CopyTrader v4 → http://localhost:${PORT}\n`));
