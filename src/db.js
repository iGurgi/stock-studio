import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', 'studio.db');

import { mkdirSync } from 'node:fs';
mkdirSync(dirname(DB_PATH), { recursive: true }); // works for a mounted volume too

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;'); // tolerate write contention when dashboard + agent share the file
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- research | tracking | proposal | placement
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running | ok | error
  summary TEXT,
  raw TEXT,                            -- raw model text / debug
  error TEXT
);

CREATE TABLE IF NOT EXISTS theses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'equity', -- equity | etf | crypto | option
  stance TEXT NOT NULL DEFAULT 'neutral',    -- bull | bear | neutral
  conviction INTEGER NOT NULL DEFAULT 3,     -- 1..5
  thesis_md TEXT NOT NULL,
  target REAL,
  stop REAL,
  status TEXT NOT NULL DEFAULT 'active',      -- active | invalidated | closed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_theses_symbol ON theses(symbol);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT,
  run_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'research',      -- research | news | tracking
  body_md TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_symbol ON notes(symbol);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'equity',
  side TEXT NOT NULL,                          -- buy | sell
  order_type TEXT NOT NULL DEFAULT 'limit',    -- market | limit
  qty REAL NOT NULL,
  limit_price REAL,
  time_in_force TEXT NOT NULL DEFAULT 'gfd',
  est_cost_usd REAL,
  rationale_md TEXT NOT NULL,
  review_json TEXT,                            -- output of the review/simulate call
  risk_json TEXT,                             -- caps check result
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected | placed | failed | expired
  decided_at TEXT,
  decided_by TEXT,
  placed_order_id TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- portfolio | pnl | positions
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',          -- info | warn | alert | error
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovered (
  symbol TEXT PRIMARY KEY,
  asset_type TEXT NOT NULL DEFAULT 'equity',
  source TEXT,                                 -- movers | news | earnings (origin)
  reason TEXT,                                 -- one-line why it surfaced
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1              -- times re-surfaced across runs
);
`);

// ---- small helpers --------------------------------------------------------
export const now = () => new Date().toISOString();

export function logEvent(level, kind, message, data) {
  db.prepare('INSERT INTO events (ts, level, kind, message, data) VALUES (?,?,?,?,?)').run(
    now(), level, kind, message, data ? JSON.stringify(data) : null,
  );
}

// Close any runs left 'running' by a previous process (killed mid-pass on
// restart/crash). Call once at server startup only — NOT from CLI tools, which
// would otherwise clobber the live app's genuinely in-flight runs.
export function markInterruptedRuns() {
  return db.prepare("UPDATE runs SET status='error', error='interrupted (process restart)', finished_at=? WHERE status='running'")
    .run(now()).changes;
}

export function startRun(kind) {
  const info = db.prepare('INSERT INTO runs (kind, started_at) VALUES (?, ?)').run(kind, now());
  return Number(info.lastInsertRowid);
}
export function finishRun(id, status, summary, raw, error) {
  db.prepare('UPDATE runs SET finished_at=?, status=?, summary=?, raw=?, error=? WHERE id=?')
    .run(now(), status, summary || null, raw || null, error || null, id);
}

export function getKv(key, dflt = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key);
  return row ? row.value : dflt;
}
export function setKv(key, value) {
  db.prepare('INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

// Master halt flag, persisted (separate from PLACEMENT_ENABLED env).
export function isHalted() {
  return getKv('halted', 'false') === 'true';
}
export function setHalted(v) {
  setKv('halted', v ? 'true' : 'false');
  logEvent('warn', 'kill_switch', v ? 'Desk halted by operator' : 'Desk resumed by operator');
}

// ---- discovered symbols (breakout discovery) ------------------------------

// Symbols the discovery pass has surfaced and is now actively researching.
export function discoveredSymbols() {
  return db.prepare('SELECT symbol FROM discovered ORDER BY last_seen DESC').all().map((r) => r.symbol);
}

// Record/refresh a discovered candidate. Re-surfacing bumps hits + last_seen.
export function upsertDiscovered(d) {
  const ts = now();
  db.prepare(`INSERT INTO discovered (symbol, asset_type, source, reason, first_seen, last_seen, hits)
    VALUES (?,?,?,?,?,?,1)
    ON CONFLICT(symbol) DO UPDATE SET
      last_seen=excluded.last_seen,
      hits=discovered.hits+1,
      source=excluded.source,
      reason=excluded.reason`)
    .run(String(d.symbol).toUpperCase(), d.asset_type || 'equity', d.source || null, d.reason || null, ts, ts);
}

// Keep the discovered universe bounded: prune anything not re-seen within
// `maxAgeDays`, then trim to the `keep` most-recently-seen. Returns # pruned.
export function pruneDiscovered({ keep = 30, maxAgeDays = 14 } = {}) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
  const stale = db.prepare('DELETE FROM discovered WHERE last_seen < ?').run(cutoff).changes;
  const overflow = db.prepare(`DELETE FROM discovered WHERE symbol NOT IN (
      SELECT symbol FROM discovered ORDER BY last_seen DESC LIMIT ?
    )`).run(keep).changes;
  return stale + overflow;
}

// Count proposals created today (ET-ish via UTC date is fine for a soft cap).
// Auto-pruned proposals (status 'expired' — dedupe / unactionable cleanup) don't
// count against the daily budget; they never became a real, surfaced trade idea.
export function proposalsToday() {
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT COUNT(*) c FROM proposals WHERE substr(created_at,1,10)=? AND status != 'expired'").get(day);
  return row.c;
}
