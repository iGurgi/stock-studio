import { db, now, logEvent } from '../db.js';
import { fetchPortfolio } from '../robinhood.js';

// Did the live fetch actually return usable account data? A genuinely empty but
// healthy account (no positions, no errors) counts as usable — we only treat a
// fetch as bad when the broker calls errored AND we got no holdings/equity back.
function isUsable(pf, errors) {
  if (!pf) return false;
  if (pf.positions && pf.positions.length) return true;
  if (pf.portfolio && pf.portfolio.equity_value != null) return true;
  return !(errors && errors.length);
}

// Most recent persisted portfolio snapshot, or null.
export function lastPortfolioSnapshot() {
  const row = db.prepare("SELECT json, taken_at FROM snapshots WHERE kind='portfolio' ORDER BY id DESC LIMIT 1").get();
  if (!row) return null;
  try { return { pf: JSON.parse(row.json), taken_at: row.taken_at }; } catch { return null; }
}

// get_portfolio exposes no day-P&L, so derive it: today's account value minus
// the day's FIRST snapshot value. Null until a baseline exists (first run of the
// day), so it shows "—" rather than a bogus 0. Soft metric — the first snapshot
// is near the desk's first pass, not necessarily the exact market open.
function dayPnlFromBaseline(currentValue) {
  if (currentValue == null) return null;
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT json FROM snapshots WHERE kind='portfolio' AND substr(taken_at,1,10)=? ORDER BY id ASC LIMIT 1").get(day);
  if (!row) return null;
  try {
    const base = JSON.parse(row.json)?.portfolio?.account_value;
    return base == null ? null : Number((currentValue - base).toFixed(2));
  } catch { return null; }
}

// Fetch the live portfolio. On a usable fetch, persist a snapshot and return it
// (stale:false). On a failed/empty fetch, fall back to the most recent snapshot
// so callers keep seeing the last-known holdings (stale:true, as_of set). If the
// fetch is bad and there is no snapshot at all, returns unavailable:true.
export async function loadPortfolio({ persist = true } = {}) {
  const { data: pf, raw, errors } = await fetchPortfolio();
  if (isUsable(pf, errors)) {
    // Derive day P&L against the day's first snapshot before persisting this one.
    if (pf?.day_pnl_usd == null) pf.day_pnl_usd = dayPnlFromBaseline(pf?.portfolio?.account_value);
    if (persist) {
      db.prepare('INSERT INTO snapshots (taken_at, kind, json) VALUES (?,?,?)').run(now(), 'portfolio', JSON.stringify(pf));
    }
    return { pf, stale: false, errors, raw };
  }
  const snap = lastPortfolioSnapshot();
  if (snap) {
    logEvent('warn', 'portfolio', `Live portfolio fetch unusable; using snapshot from ${snap.taken_at}`, { errors });
    return { pf: snap.pf, stale: true, as_of: snap.taken_at, errors, raw };
  }
  logEvent('warn', 'portfolio', 'Live portfolio fetch unusable and no snapshot on file', { errors });
  return { pf, stale: false, unavailable: true, errors, raw };
}
