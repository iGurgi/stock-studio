// Populate a throwaway SQLite DB with realistic *fake* data so you can run the
// dashboard with a full, presentable state — for screenshots, demos, or just to
// see the UI without wiring up real credentials. No real account is ever touched.
//
//   node scripts/seed-demo.mjs                 # seeds ./data/demo.db
//   DB_PATH=data/demo.db node scripts/seed-demo.mjs
//
// Then run the dashboard against it (placement disabled so nothing looks armed):
//   DB_PATH=data/demo.db PLACEMENT_ENABLED=false CONTROL_TOKEN=demo node src/server.js
//
// Everything here is invented — tickers, prices, P&L, theses. Not advice.
import { existsSync } from 'node:fs';

// Default to a demo DB so we never clobber the live studio.db. Guard anyway.
process.env.DB_PATH = process.env.DB_PATH || 'data/demo.db';
if (/studio\.db$/.test(process.env.DB_PATH) && !process.argv.includes('--force')) {
  console.error(`Refusing to seed ${process.env.DB_PATH} — that looks like the live DB.`);
  console.error('Use the default (data/demo.db) or pass --force if you really mean it.');
  process.exit(1);
}

// Import after DB_PATH is set so db.js opens the demo file.
const { db, now } = await import('../src/db.js');

const fresh = !existsSync(process.env.DB_PATH);
const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

// Wipe demo tables so the script is re-runnable.
for (const t of ['theses', 'proposals', 'snapshots', 'events', 'runs', 'notes', 'discovered']) {
  db.prepare(`DELETE FROM ${t}`).run();
}

// --- portfolio snapshot (drives the top stat bar) --------------------------
const portfolio = {
  portfolio: { account_value: 24850.12, equity_value: 18230.40, buying_power: 6619.72, cash: 6619.72, crypto_value: 3120.55 },
  day_pnl_usd: 312.84,
  positions: [
    { symbol: 'NVDA', asset_type: 'equity', qty: 12, avg_cost: 118.40, mark: 131.20, market_value: 1574.40, unrealized_pnl: 153.60 },
    { symbol: 'SOFI', asset_type: 'equity', qty: 200, avg_cost: 7.85, mark: 9.10, market_value: 1820.00, unrealized_pnl: 250.00 },
    { symbol: 'BTC-USD', asset_type: 'crypto', qty: 0.03, avg_cost: 91000, mark: 104000, market_value: 3120.00, unrealized_pnl: 390.00 },
  ],
  realized_pnl_30d_usd: 1184.22,
};
db.prepare('INSERT INTO snapshots (taken_at, kind, json) VALUES (?,?,?)').run(iso(6), 'portfolio', JSON.stringify(portfolio));

// --- theses ----------------------------------------------------------------
const theses = [
  { symbol: 'NVDA', stance: 'bull', conviction: 5, target: 150, stop: 120,
    thesis_md: 'Datacenter demand still outrunning supply; next print is the catalyst. Invalidated below the $120 base.' },
  { symbol: 'SOFI', stance: 'bull', conviction: 4, target: 11, stop: 8,
    thesis_md: 'Bank-charter operating leverage + deposit growth. Thesis breaks if net-interest margin rolls over (watch $8).' },
  { symbol: 'BTC-USD', asset_type: 'crypto', stance: 'bull', conviction: 4, target: 120000, stop: 88000,
    thesis_md: 'Post-halving supply squeeze + steady ETF inflows. A weekly close under $88k would void the setup.' },
  { symbol: 'TSLA', stance: 'neutral', conviction: 2, target: null, stop: null,
    thesis_md: 'Deliveries decelerating into a rich multiple; no edge either way until the energy segment reprices. Watching.' },
  { symbol: 'PLTR', stance: 'bear', conviction: 3, target: 22, stop: 32,
    thesis_md: 'Commercial bookings strong but the valuation prices in flawless execution. Fade strength toward $32.' },
  { symbol: 'RIVN', stance: 'bull', conviction: 3, target: 18, stop: 13,
    thesis_md: 'R2 reveal + cost-down roadmap; gross-margin inflection is the proof point. Below $13 the runway thins.' },
];
const insThesis = db.prepare(`INSERT INTO theses (symbol, asset_type, stance, conviction, thesis_md, target, stop, status, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?, 'active', ?, ?)`);
theses.forEach((t, i) => insThesis.run(t.symbol, t.asset_type || 'equity', t.stance, t.conviction, t.thesis_md, t.target, t.stop, iso(2880 - i * 120), iso(30 + i * 7)));

// --- proposals: a couple pending (the gate) + one placed (open orders) -----
const insProp = db.prepare(`INSERT INTO proposals
  (created_at, symbol, asset_type, side, order_type, qty, limit_price, time_in_force, est_cost_usd, rationale_md, review_json, risk_json, status, decided_at, decided_by, placed_order_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const review = (cost, price, warnings = []) => JSON.stringify({ ok: true, estimated_cost_usd: cost, estimated_price: price, warnings });
const risk = JSON.stringify({ maxPositionUsd: 2000 });

// pending — show up in "Awaiting your sign-off"
insProp.run(iso(18), 'NVDA', 'equity', 'buy', 'limit', 2, 131.50, 'gfd', 263.00,
  'Adding to the winner ahead of the print, sized small. Stop the thesis below $120.', review(262.40, 131.20), risk, 'pending', null, null, null);
insProp.run(iso(12), 'SOFI', 'equity', 'buy', 'limit', 100, 9.05, 'gfd', 905.00,
  'Starter position on the deposit-growth thesis; limit just under the ask.', review(904.00, 9.04, ['limit slightly through the spread']), risk, 'pending', null, null, null);

// placed — shows in "Open orders" with a (fake) broker id
insProp.run(iso(40), 'RIVN', 'equity', 'buy', 'limit', 1, 15.66, 'gtc', 15.66,
  'Toe-in position tied to the R2 catalyst.', review(15.62, 15.62), risk, 'placed', iso(39), 'operator', 'demo-7a1c0f3e-rivn');

// --- discovered candidates -------------------------------------------------
const insDisc = db.prepare(`INSERT INTO discovered (symbol, asset_type, source, reason, first_seen, last_seen, hits) VALUES (?,?,?,?,?,?,?)`);
[
  ['CLS', 'movers', 'On a Robinhood movers/active list', 3],
  ['NBIS', 'news', 'AI-infra capex headlines; unusual volume', 1],
  ['AVAV', 'earnings', 'Reports earnings within 7 days', 2],
].forEach(([sym, src, reason, hits]) => insDisc.run(sym, 'equity', src, reason, iso(600), iso(45), hits));

// --- desk activity (events) ------------------------------------------------
const insEvent = db.prepare('INSERT INTO events (ts, level, kind, message, data) VALUES (?,?,?,?,?)');
[
  [42, 'info', 'discovery', 'Discovery added 3, pruned 1. Tracked: 14'],
  [38, 'info', 'research', 'Research pass updated 14 theses'],
  [33, 'alert', 'placement', 'ORDER PLACED #3 RIVN (order demo-7a1c0f3e-rivn)'],
  [33, 'warn', 'placement', 'Operator approved #3: buy 1 RIVN'],
  [22, 'warn', 'tracking', 'NVDA: approaching target $150 — consider trimming'],
  [18, 'info', 'proposal', 'New pending proposal: buy 2 NVDA @ 131.5'],
  [12, 'info', 'proposal', 'New pending proposal: buy 100 SOFI @ 9.05'],
  [6, 'info', 'tracking', 'Snapshot taken; 3 open positions'],
].forEach(([m, lvl, kind, msg]) => insEvent.run(iso(m), lvl, kind, msg, null));

// --- recent runs -----------------------------------------------------------
const insRun = db.prepare('INSERT INTO runs (kind, started_at, finished_at, status, summary) VALUES (?,?,?,?,?)');
[
  ['discovery', 44, 42, 'ok', '3 new candidates; 1 pruned'],
  ['research', 42, 38, 'ok', 'Updated 14/14 theses'],
  ['tracking', 22, 22, 'ok', '1 alerts, 0 invalidations'],
  ['proposal', 18, 17, 'ok', '2 pending proposals written'],
  ['tracking', 6, 6, 'ok', 'Snapshot taken; 3 open positions'],
].forEach(([kind, s, f, st, sum]) => insRun.run(kind, iso(s), iso(f), st, sum));

console.log(`Seeded demo data into ${process.env.DB_PATH}${fresh ? ' (new file)' : ''}.`);
console.log('Run the dashboard against it:');
console.log(`  DB_PATH=${process.env.DB_PATH} PLACEMENT_ENABLED=false CONTROL_TOKEN=demo node src/server.js`);
