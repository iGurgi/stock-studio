import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, assertConfig, equitiesOpen, secretsStatus, setSecret } from './config.js';
import { db, now, logEvent, isHalted, setHalted, proposalsToday, markInterruptedRuns } from './db.js';
import { placeApprovedOrder, cancelOrder } from './robinhood.js';
import { researchPass } from './agent/research.js';
import { trackingPass } from './agent/tracking.js';
import { proposalPass } from './agent/proposals.js';
import { discoveryPass } from './agent/discovery.js';
import { startScheduler } from './agent/scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// --- auth for write actions ----------------------------------------------
function requireToken(req, res, next) {
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!config.server.controlToken || tok !== config.server.controlToken) {
    return res.status(401).json({ error: 'bad control token' });
  }
  next();
}

// --- read endpoints -------------------------------------------------------
app.get('/api/state', (req, res) => {
  const latestPortfolio = db.prepare("SELECT json, taken_at FROM snapshots WHERE kind='portfolio' ORDER BY id DESC LIMIT 1").get();
  res.json({
    halted: isHalted(),
    placementEnabled: config.placementEnabled,
    equitiesOpen: equitiesOpen(),
    configProblems: assertConfig(),
    counts: {
      pending: db.prepare("SELECT COUNT(*) c FROM proposals WHERE status='pending'").get().c,
      activeTheses: db.prepare("SELECT COUNT(*) c FROM theses WHERE status='active'").get().c,
      proposalsToday: proposalsToday(),
      maxPerDay: config.rails.maxNewTradesPerDay,
    },
    rails: config.rails,
    portfolio: latestPortfolio ? { ...JSON.parse(latestPortfolio.json), taken_at: latestPortfolio.taken_at } : null,
  });
});

app.get('/api/proposals', (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM proposals WHERE status=? ORDER BY id DESC LIMIT 100').all(status)
    : db.prepare('SELECT * FROM proposals ORDER BY id DESC LIMIT 100').all();
  res.json(rows.map((r) => ({ ...r, review: r.review_json ? JSON.parse(r.review_json) : null })));
});

app.get('/api/theses', (req, res) => {
  res.json(db.prepare("SELECT * FROM theses WHERE status='active' ORDER BY conviction DESC, updated_at DESC").all());
});

app.get('/api/events', (req, res) => {
  res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 200').all());
});

app.get('/api/runs', (req, res) => {
  res.json(db.prepare('SELECT id, kind, started_at, finished_at, status, summary, error FROM runs ORDER BY id DESC LIMIT 50').all());
});

// Masked status of the runtime-editable secrets. Never returns the values
// themselves — only whether each is set, where it came from, and a last-4 hint.
app.get('/api/settings', (req, res) => {
  res.json({ secrets: secretsStatus() });
});

// --- write endpoints (token required) ------------------------------------

// Save (or clear) the runtime secrets. Persisted in the DB so they survive
// restarts. A field that is omitted is left untouched; an empty string clears
// the saved value (falling back to the env var, if any).
app.post('/api/settings', requireToken, (req, res) => {
  const map = {
    robinhoodMcpToken: 'robinhoodMcpToken',
    robinhoodAccount: 'robinhoodAccount',
    llmApiKey: 'llmApiKey',
    searchApiKey: 'searchApiKey',
    coinbaseApiKeyName: 'coinbaseApiKeyName',
    coinbaseApiSecret: 'coinbaseApiSecret',
  };
  const changed = [];
  for (const [field, name] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      setSecret(name, req.body[field]);
      changed.push(field);
    }
  }
  if (!changed.length) return res.status(400).json({ error: 'no recognized settings in body' });
  logEvent('info', 'settings', `Operator updated credentials: ${changed.join(', ')}`);
  res.json({ ok: true, changed, secrets: secretsStatus(), configProblems: assertConfig() });
});

// The human gate. This is the ONLY way a real order is placed.
app.post('/api/proposals/:id/approve', requireToken, async (req, res) => {
  const p = db.prepare("SELECT * FROM proposals WHERE id=? AND status='pending'").get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'no such pending proposal' });
  if (isHalted()) return res.status(409).json({ error: 'desk is halted' });
  if (!config.placementEnabled) {
    return res.status(409).json({ error: 'PLACEMENT_ENABLED is false; flip it in .env once you trust the desk' });
  }
  // Require an explicit typed confirmation matching the symbol — guards fat-fingers.
  if ((req.body?.confirm || '').toUpperCase() !== p.symbol) {
    return res.status(400).json({ error: `type the symbol (${p.symbol}) in "confirm" to place` });
  }
  db.prepare("UPDATE proposals SET status='approved', decided_at=?, decided_by=? WHERE id=?")
    .run(now(), req.body?.by || 'operator', p.id);
  logEvent('warn', 'placement', `Operator approved #${p.id}: ${p.side} ${p.qty} ${p.symbol}`);
  try {
    const result = await placeApprovedOrder(p);
    if (result.placed) {
      db.prepare("UPDATE proposals SET status='placed', placed_order_id=? WHERE id=?").run(result.order_id, p.id);
      logEvent('alert', 'placement', `ORDER PLACED #${p.id} ${p.symbol} (order ${result.order_id})`);
      return res.json({ ok: true, order_id: result.order_id });
    }
    db.prepare("UPDATE proposals SET status='failed', error=? WHERE id=?").run(result.error || 'unknown', p.id);
    logEvent('error', 'placement', `Placement failed #${p.id}: ${result.error}`);
    return res.status(502).json({ error: result.error || 'placement failed' });
  } catch (err) {
    db.prepare("UPDATE proposals SET status='failed', error=? WHERE id=?").run(String(err.message || err), p.id);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/proposals/:id/reject', requireToken, (req, res) => {
  const info = db.prepare("UPDATE proposals SET status='rejected', decided_at=?, decided_by=? WHERE id=? AND status='pending'")
    .run(now(), req.body?.by || 'operator', Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'no such pending proposal' });
  logEvent('info', 'placement', `Operator rejected #${req.params.id}`);
  res.json({ ok: true });
});

// Cancel a live order. Not gated by PLACEMENT_ENABLED — canceling reduces risk
// and must always be available, even when new placement is disabled.
app.post('/api/proposals/:id/cancel', requireToken, async (req, res) => {
  const p = db.prepare("SELECT * FROM proposals WHERE id=? AND status='placed'").get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'no such placed order' });
  if (!p.placed_order_id) return res.status(409).json({ error: 'order has no broker id to cancel' });
  try {
    const result = await cancelOrder(p.placed_order_id, p.asset_type);
    if (!result.canceled) {
      logEvent('error', 'placement', `Cancel failed #${p.id} ${p.symbol}: ${result.error}`);
      return res.status(502).json({ error: result.error || 'cancel failed' });
    }
    db.prepare("UPDATE proposals SET status='canceled', decided_at=? WHERE id=?").run(now(), p.id);
    logEvent('warn', 'placement', `Order canceled #${p.id} ${p.symbol} (order ${p.placed_order_id})`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/halt', requireToken, (req, res) => {
  setHalted(!!req.body?.halted);
  res.json({ ok: true, halted: isHalted() });
});

app.post('/api/agent/run', requireToken, async (req, res) => {
  const kind = req.body?.kind;
  const fns = { research: researchPass, tracking: trackingPass, proposal: proposalPass, discovery: discoveryPass };
  if (!fns[kind]) return res.status(400).json({ error: 'kind must be research|tracking|proposal|discovery' });
  // Don't start a pass that's already in flight (manual triggers bypass the
  // scheduler's own overlap guard); doubling up just contends for the LLM/MCP.
  const active = db.prepare("SELECT 1 FROM runs WHERE kind=? AND status='running' LIMIT 1").get(kind);
  if (active) return res.status(409).json({ error: `${kind} already running` });
  res.json({ ok: true, started: kind }); // return immediately; pass runs in background
  fns[kind]().catch((e) => logEvent('error', 'manual', `${kind} failed: ${e.message}`));
});

// --- static dashboard -----------------------------------------------------
app.use(express.static(join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

const problems = assertConfig();
if (problems.length) {
  console.warn('[config] warnings:\n - ' + problems.join('\n - '));
}

app.listen(config.server.port, config.server.host, () => {
  console.log(`[stock-studio] dashboard on http://${config.server.host}:${config.server.port}`);
  logEvent('info', 'server', `Dashboard up on ${config.server.host}:${config.server.port}`);
  // A restart kills any in-flight pass; close those stale 'running' rows so they
  // don't linger in Desk Activity. Safe here — the scheduler hasn't kicked yet.
  const swept = markInterruptedRuns();
  if (swept) logEvent('info', 'server', `Marked ${swept} interrupted run(s) from previous process`);
  if (process.env.RUN_SCHEDULER !== 'false') startScheduler();
});
