// Replay the desk's historical proposals — buys AND sells, equity/etf AND
// crypto — against real price history into a single simulated capital pool,
// respecting the live position-size and symbol-exposure rails. Portfolio-
// aware (capital-constrained), not per-idea-in-isolation. Produces a
// day-by-day equity curve, not just per-horizon medians: evidence a
// skeptical operator would actually look at.
//
//   node scripts/backtest.mjs
//   node scripts/backtest.mjs --capital 20000 --window 3 --verbose
//   node scripts/backtest.mjs --json > curve.json
//
// Hypothetical, naive-fill (a limit fills the first bar that touches it
// within the fill window; a market fills at the entry bar's close), NOT a
// performance guarantee. This is a *parallel* capital universe seeded with
// --capital, not a replay of the account's real fills/cash — a sell with no
// matching simulated open lot (e.g. a real position the backtest's own
// capital never bought) is skipped, not treated as a short. Options remain
// out of scope (no clean price-history fill model for multi-leg/IV-driven
// instruments here).
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { getHistoricals } from '../src/robinhood.js';
import { getProductCandles } from '../src/coinbase.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const CAPITAL = Number(arg('capital', 20000));
const FILL_WINDOW = Number(arg('window', 3)); // trading days a limit has to get hit
const VERBOSE = process.argv.includes('--verbose');
const JSON_OUT = process.argv.includes('--json');
const isCrypto = (s) => /-USD$/i.test(s);

const pct = (x) => (x == null ? '   —  ' : `${(x * 100).toFixed(1)}%`.padStart(6));
const usd = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }));

const all = db.prepare(
  "SELECT id, created_at, symbol, asset_type, side, order_type, qty, limit_price FROM proposals ORDER BY created_at, id",
).all();
// Options aren't evaluable here — no clean price-history fill model for them.
const evaluable = all.filter((p) => p.asset_type !== 'option' && p.created_at && Number(p.qty) > 0);
const skipped = {
  options: all.length - evaluable.length,
  noCryptoSource: 0, noData: 0, neverFilled: 0,
  overPositionCap: 0, overSymbolCap: 0, noCapital: 0, noOpenLot: 0,
};

if (!evaluable.length) {
  console.log(`No evaluable proposals yet (options=${skipped.options}).`);
  console.log('The backtest grows as the desk generates buy/sell proposals.');
  process.exit(0);
}

const cryptoSourceReady = !!(config.coinbase.enabled && config.coinbase.apiKeyName && config.coinbase.apiSecret);

// ---- 1. fetch daily bars per symbol (equity/etf via Robinhood, crypto via Coinbase) ----
const barsBySym = new Map();
for (const sym of [...new Set(evaluable.map((p) => p.symbol))]) {
  const symProps = evaluable.filter((p) => p.symbol === sym);
  const earliest = symProps.map((p) => p.created_at).sort()[0];
  if (isCrypto(sym)) {
    if (!cryptoSourceReady) { skipped.noCryptoSource += symProps.length; barsBySym.set(sym, []); continue; }
    barsBySym.set(sym, await getProductCandles(sym, earliest).catch(() => []));
  } else {
    barsBySym.set(sym, await getHistoricals(sym, earliest).catch(() => []));
  }
}

// ---- 2. determine fill outcome per proposal — a pure price-history question,
// independent of whether the simulated portfolio could actually afford it ----
function determineFill(p) {
  const bars = barsBySym.get(p.symbol) || [];
  if (!bars.length) return { p, outcome: 'noData' };
  const day = String(p.created_at).slice(0, 10);
  const entryIdx = bars.findIndex((b) => b.date >= day);
  if (entryIdx < 0) return { p, outcome: 'noData' };

  const limit = Number(p.limit_price);
  if ((p.order_type || 'limit') === 'limit' && Number.isFinite(limit)) {
    // A buy limit fills when price trades down to it; a sell limit fills when
    // price trades up to it — both within the fill window.
    const touchesLimit = p.side === 'buy' ? (b) => b.low <= limit : (b) => b.high >= limit;
    const hit = bars.slice(entryIdx, entryIdx + FILL_WINDOW + 1).findIndex(touchesLimit);
    if (hit < 0) return { p, outcome: 'neverFilled' };
    return { p, outcome: 'filled', fillDate: bars[entryIdx + hit].date, fillPrice: limit };
  }
  return { p, outcome: 'filled', fillDate: bars[entryIdx].date, fillPrice: bars[entryIdx].close };
}

const fillResults = evaluable.map(determineFill);
for (const r of fillResults) {
  if (r.outcome === 'noData') skipped.noData++;
  else if (r.outcome === 'neverFilled') skipped.neverFilled++;
}
const fills = fillResults.filter((r) => r.outcome === 'filled')
  .sort((a, b) => a.fillDate.localeCompare(b.fillDate) || a.p.id - b.p.id);

// ---- 3. day-by-day capital-constrained ledger walk -------------------------
// One pass over every trading day in the span: apply that day's fills against
// a single cash pool + FIFO symbol lots (rails-checked), then mark open lots
// to that day's close for the equity curve point.
const closeBySymDate = new Map();
for (const [sym, bars] of barsBySym) closeBySymDate.set(sym, new Map(bars.map((b) => [b.date, b.close])));
const allDates = [...new Set([...barsBySym.values()].flat().map((b) => b.date))].sort();

let cash = CAPITAL;
const lotsBySymbol = new Map(); // symbol -> [{qty, price, fillDate}], FIFO order
const lastClose = new Map();    // symbol -> most recent known close (forward-filled)
const closedTrades = [];        // {symbol, qty, entryPrice, exitPrice, pnl, retPct, entryDate, exitDate}
const curve = [];
let fillIdx = 0;

const symbolExposure = (sym) => (lotsBySymbol.get(sym) || []).reduce((s, l) => s + l.qty * l.price, 0);
const openMarketValue = () => {
  let v = 0;
  for (const [sym, lots] of lotsBySymbol) {
    const px = lastClose.get(sym);
    if (px != null) for (const lot of lots) v += lot.qty * px;
  }
  return v;
};

for (const date of allDates) {
  for (const [sym, m] of closeBySymDate) { const c = m.get(date); if (c != null) lastClose.set(sym, c); }

  while (fillIdx < fills.length && fills[fillIdx].fillDate === date) {
    const r = fills[fillIdx++];
    const { p, fillPrice } = r;
    if (p.side === 'buy') {
      const qty = Number(p.qty);
      const cost = qty * fillPrice;
      if (config.rails.maxPositionUsd > 0 && cost > config.rails.maxPositionUsd) { skipped.overPositionCap++; r.outcome = 'overPositionCap'; continue; }
      if (config.rails.maxSymbolExposureUsd > 0 && symbolExposure(p.symbol) + cost > config.rails.maxSymbolExposureUsd) { skipped.overSymbolCap++; r.outcome = 'overSymbolCap'; continue; }
      if (cost > cash) { skipped.noCapital++; r.outcome = 'noCapital'; continue; }
      cash -= cost;
      const lots = lotsBySymbol.get(p.symbol) || [];
      lots.push({ qty, price: fillPrice, fillDate: date });
      lotsBySymbol.set(p.symbol, lots);
      r.applied = { cost, qty };
    } else {
      let remaining = Number(p.qty);
      const lots = lotsBySymbol.get(p.symbol) || [];
      let proceeds = 0, costBasis = 0, matchedQty = 0, entryDateEarliest = null;
      while (remaining > 1e-9 && lots.length) {
        const lot = lots[0];
        const q = Math.min(remaining, lot.qty);
        proceeds += q * fillPrice; costBasis += q * lot.price; matchedQty += q;
        entryDateEarliest = entryDateEarliest ? (entryDateEarliest < lot.fillDate ? entryDateEarliest : lot.fillDate) : lot.fillDate;
        lot.qty -= q; remaining -= q;
        if (lot.qty <= 1e-9) lots.shift();
      }
      if (matchedQty <= 0) { skipped.noOpenLot++; r.outcome = 'noOpenLot'; continue; }
      cash += proceeds;
      const pnl = proceeds - costBasis;
      closedTrades.push({ symbol: p.symbol, qty: matchedQty, entryPrice: costBasis / matchedQty, exitPrice: fillPrice, pnl, retPct: costBasis ? pnl / costBasis : null, entryDate: entryDateEarliest, exitDate: date });
      r.applied = { proceeds, matchedQty, pnl };
    }
  }

  curve.push({ date, cash: Number(cash.toFixed(2)), equity: Number((cash + openMarketValue()).toFixed(2)) });
}

// ---- 4. report --------------------------------------------------------------
const startEquity = CAPITAL;
const endEquity = curve.length ? curve[curve.length - 1].equity : CAPITAL;
let peak = -Infinity, maxDrawdownPct = 0;
for (const pt of curve) { peak = Math.max(peak, pt.equity); maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - pt.equity) / peak : 0); }

if (JSON_OUT) {
  console.log(JSON.stringify({ capital: CAPITAL, curve, closedTrades, skipped, startEquity, endEquity }, null, 2));
  process.exit(0);
}

console.log(`\nBacktest v2 — ${evaluable.length} evaluable proposal(s) · capital ${usd(CAPITAL)} · fill window ${FILL_WINDOW}d`);
console.log(`(skipped: ${skipped.options} options, ${skipped.noCryptoSource} crypto/no-source, ${skipped.noData} no-data, ${skipped.neverFilled} never-filled, ${skipped.overPositionCap} over-position-cap, ${skipped.overSymbolCap} over-symbol-cap, ${skipped.noCapital} insufficient-capital, ${skipped.noOpenLot} sell-no-open-lot)`);
console.log('(hypothetical, naive-fill, simulated capital — not a performance guarantee)\n');

console.log(`equity:  start ${usd(startEquity)}  ->  end ${usd(endEquity)}   total return ${pct((endEquity - startEquity) / startEquity)}   max drawdown ${pct(maxDrawdownPct)}`);

const wins = closedTrades.filter((t) => t.pnl > 0).length;
console.log(`trades:  ${closedTrades.length} closed (FIFO-matched sells)  ·  win rate ${closedTrades.length ? pct(wins / closedTrades.length) : '  —  '}  ·  open at end: ${[...lotsBySymbol.values()].reduce((n, lots) => n + lots.length, 0)} lot(s) across ${[...lotsBySymbol.entries()].filter(([, l]) => l.length).length} symbol(s)`);

// Sparkline + sampled table — readable terminal evidence without a chart lib.
if (curve.length >= 2) {
  const BLOCKS = '▁▂▃▄▅▆▇█';
  const vals = curve.map((c) => c.equity);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
  const spark = vals.map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor((v - lo) / span * BLOCKS.length))]).join('');
  console.log(`\nequity curve (${curve.length} trading days, low ${usd(lo)} / high ${usd(hi)}):`);
  console.log(spark);

  const sampleEvery = Math.max(1, Math.floor(curve.length / 12));
  console.log('\ndate         equity      vs-start');
  for (let i = 0; i < curve.length; i += sampleEvery) {
    const c = curve[i];
    console.log(`${c.date}   ${usd(c.equity).padStart(9)}   ${pct((c.equity - startEquity) / startEquity)}`);
  }
  const last = curve[curve.length - 1];
  console.log(`${last.date}   ${usd(last.equity).padStart(9)}   ${pct((last.equity - startEquity) / startEquity)}  (final)`);
}

if (VERBOSE) {
  console.log(`\nper-proposal:`);
  for (const r of fillResults) {
    const p = r.p;
    if (r.outcome === 'noData') { console.log(`  #${p.id} ${p.symbol} — no price data at ${String(p.created_at).slice(0, 10)}`); continue; }
    if (r.outcome === 'neverFilled') { console.log(`  #${p.id} ${p.symbol} ${p.side} @ ${p.limit_price} — never filled within ${FILL_WINDOW}d`); continue; }
    if (['overPositionCap', 'overSymbolCap', 'noCapital', 'noOpenLot'].includes(r.outcome)) {
      console.log(`  #${p.id} ${p.symbol} ${p.side} ${p.qty} @ ${r.fillPrice} filled ${r.fillDate} — skipped (${r.outcome})`);
      continue;
    }
    if (p.side === 'buy' && r.applied) console.log(`  #${p.id} ${p.symbol} buy ${r.applied.qty} @ ${r.fillPrice} (${r.fillDate}) — ${usd(r.applied.cost)}`);
    else if (r.applied) console.log(`  #${p.id} ${p.symbol} sell ${r.applied.matchedQty} @ ${r.fillPrice} (${r.fillDate}) — pnl ${usd(r.applied.pnl)}`);
  }
}
console.log('');
process.exit(0);
