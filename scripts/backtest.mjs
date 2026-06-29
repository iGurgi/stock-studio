// Replay the desk's historical BUY proposals against real price history to
// estimate how the *ideas* would have performed — signal QA before you trust
// the desk enough to arm placement. Read-only and deterministic: it reads the
// proposals table and fetches daily bars; it never places or cancels anything.
//
//   node scripts/backtest.mjs                       # against ./data/studio.db
//   DB_PATH=data/studio.db node scripts/backtest.mjs
//   node scripts/backtest.mjs --horizons 1,5,20 --window 3 --verbose
//
// v0 scope: equity BUY proposals only. Sells are exits (no clean directional
// return) and crypto needs a different price source — both are reported as
// skipped. Hypothetical, naive-fill, NOT a performance guarantee.
import { db } from '../src/db.js';
import { getHistoricals } from '../src/robinhood.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const HORIZONS = String(arg('horizons', '1,5,20')).split(',').map(Number).filter((n) => n > 0);
const FILL_WINDOW = Number(arg('window', 3));         // trading days a limit has to get hit
const VERBOSE = process.argv.includes('--verbose');
const MAX_H = Math.max(...HORIZONS);

const pct = (x) => (x == null ? '   —  ' : `${(x * 100).toFixed(1)}%`.padStart(6));
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const all = db.prepare("SELECT id, created_at, symbol, asset_type, side, order_type, qty, limit_price, status FROM proposals ORDER BY created_at").all();
const buys = all.filter((p) => p.side === 'buy');
const evaluable = buys.filter((p) => p.asset_type !== 'crypto' && p.created_at);
const skipped = { sells: all.length - buys.length, crypto: buys.filter((p) => p.asset_type === 'crypto').length };

if (!evaluable.length) {
  console.log(`No evaluable buy proposals yet (buys=${buys.length}, of which crypto=${skipped.crypto}; sells=${skipped.sells}).`);
  console.log('The backtest grows as the desk generates equity buy proposals.');
  process.exit(0);
}

// Fetch bars once per symbol, covering the earliest entry through now.
const barsBySym = new Map();
for (const sym of [...new Set(evaluable.map((p) => p.symbol))]) {
  const earliest = evaluable.filter((p) => p.symbol === sym).map((p) => p.created_at).sort()[0];
  barsBySym.set(sym, await getHistoricals(sym, earliest).catch(() => []));
}

const results = []; // { p, filled, entry, retByH }
for (const p of evaluable) {
  const bars = barsBySym.get(p.symbol) || [];
  const day = String(p.created_at).slice(0, 10);
  const entryIdx = bars.findIndex((b) => b.date >= day);
  if (entryIdx < 0) { results.push({ p, noData: true }); continue; }

  const limit = Number(p.limit_price);
  let filledIdx = entryIdx;
  let entry = bars[entryIdx].close;
  let filled = true;
  if ((p.order_type || 'limit') === 'limit' && Number.isFinite(limit)) {
    // A buy limit fills when price trades down to it within the fill window.
    const hit = bars.slice(entryIdx, entryIdx + FILL_WINDOW + 1).findIndex((b) => b.low <= limit);
    if (hit < 0) { results.push({ p, filled: false }); continue; }
    filledIdx = entryIdx + hit;
    entry = limit;
  }

  const retByH = {};
  for (const h of HORIZONS) {
    const exit = bars[filledIdx + h];
    retByH[h] = exit ? (exit.close - entry) / entry : null;
  }
  results.push({ p, filled, entry, filledDate: bars[filledIdx].date, retByH });
}

const considered = results.filter((r) => !r.noData);
const fills = considered.filter((r) => r.filled);
console.log(`\nBacktest — ${evaluable.length} equity buy proposal(s) · fill window ${FILL_WINDOW}d · horizons ${HORIZONS.join('/')}d`);
console.log(`(skipped: ${skipped.sells} sells, ${skipped.crypto} crypto; hypothetical, naive fill, not a guarantee)\n`);
console.log(`fills: ${fills.length}/${considered.length} buy limits hit${considered.length - fills.length ? ` (${considered.length - fills.length} never filled)` : ''}`);

console.log(`\nhorizon  evaluated  hit%    avg-ret  median   best     worst`);
for (const h of HORIZONS) {
  const rets = fills.map((r) => r.retByH[h]).filter((x) => x != null);
  if (!rets.length) { console.log(`${(h + 'd').padEnd(8)} ${'0'.padStart(8)}   (not enough forward history)`); continue; }
  const hit = rets.filter((x) => x > 0).length / rets.length;
  console.log(`${(h + 'd').padEnd(8)} ${String(rets.length).padStart(8)}   ${pct(hit)}  ${pct(mean(rets))}  ${pct(median(rets))}  ${pct(Math.max(...rets))}  ${pct(Math.min(...rets))}`);
}

if (VERBOSE) {
  console.log(`\nper-proposal:`);
  for (const r of results) {
    if (r.noData) { console.log(`  #${r.p.id} ${r.p.symbol} — no price data at ${String(r.p.created_at).slice(0, 10)}`); continue; }
    if (!r.filled) { console.log(`  #${r.p.id} ${r.p.symbol} buy @ ${r.p.limit_price} — never filled within ${FILL_WINDOW}d`); continue; }
    const rs = HORIZONS.map((h) => `${h}d ${r.retByH[h] == null ? '—' : (r.retByH[h] * 100).toFixed(1) + '%'}`).join('  ');
    console.log(`  #${r.p.id} ${r.p.symbol} entry ${r.entry} (${r.filledDate}) — ${rs}`);
  }
}
console.log('');
process.exit(0);
