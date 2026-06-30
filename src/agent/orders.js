import { db, logEvent, now } from '../db.js';
import { getOrderById } from '../robinhood.js';

// Broker order states that are terminal in our model.
const DEAD = new Set(['cancelled', 'canceled', 'rejected', 'expired', 'failed', 'voided']);

// Broker order field names for the average fill price aren't pinned down in
// our MCP discovery notes (see robinhood.js), so probe the likely candidates
// and fall back to the limit price we placed at.
function fillPriceOf(o, fallback) {
  const cand = o.average_price ?? o.price ?? o.executed_price ?? o.average_fill_price ?? o.avg_fill_price;
  const n = Number(cand);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// FIFO-match a just-filled sell against earlier filled buy lots of the same
// symbol/asset_type, recording one `trades` row per lot consumed and crediting
// realized $ and R back to the thesis that produced the buy. Skips options — a
// sell there can be an opening trade (e.g. a covered call), not a closing exit,
// matching the actionability gate in agent/proposals.js.
function attributeRealizedPnl(sell) {
  if (sell.asset_type === 'option') return;
  let remaining = Number(sell.filled_qty) || 0;
  if (remaining <= 0) return;

  const lots = db.prepare(
    `SELECT id, thesis_id, fill_price, remaining_qty, filled_at FROM proposals
     WHERE symbol=? AND asset_type=? AND side='buy' AND status='filled' AND remaining_qty > 0
     ORDER BY filled_at ASC, id ASC`,
  ).all(sell.symbol, sell.asset_type);

  for (const lot of lots) {
    if (remaining <= 0) break;
    const qty = Math.min(remaining, lot.remaining_qty);
    if (qty <= 0) continue;

    const thesis = lot.thesis_id ? db.prepare('SELECT stop FROM theses WHERE id=?').get(lot.thesis_id) : null;
    const riskPerShare = (thesis?.stop != null && lot.fill_price != null) ? Math.abs(lot.fill_price - thesis.stop) : null;
    const pnl = (sell.fill_price - lot.fill_price) * qty;
    const r = (riskPerShare && riskPerShare > 0) ? pnl / (riskPerShare * qty) : null;

    db.prepare(`INSERT INTO trades
      (symbol, asset_type, thesis_id, buy_proposal_id, sell_proposal_id, qty, entry_price, exit_price, realized_pnl_usd, realized_r, opened_at, closed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sell.symbol, sell.asset_type, lot.thesis_id, lot.id, sell.id, qty,
        lot.fill_price, sell.fill_price, pnl, r, lot.filled_at, sell.filled_at);
    db.prepare('UPDATE proposals SET remaining_qty = remaining_qty - ? WHERE id=?').run(qty, lot.id);
    remaining -= qty;

    logEvent(pnl >= 0 ? 'info' : 'warn', 'pnl',
      `Closed ${qty} ${sell.symbol} @ ${sell.fill_price} vs entry ${lot.fill_price}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}${r != null ? ` (${r.toFixed(2)}R)` : ''}`);
  }

  if (remaining > 1e-6) {
    logEvent('warn', 'pnl', `Sell #${sell.id} ${sell.symbol}: ${remaining} unit(s) had no tracked open lot (pre-existing/external position) — not attributed`);
  }
}

// Reconcile every proposal we left in `placed` against its real broker state, so
// a fill or an out-of-band cancel is reflected back instead of lingering in the
// Open orders panel forever. Read-only at the broker; only updates our own rows.
//
//   filled at broker (cumulative_quantity >= quantity, or state 'filled') -> 'filled'
//   dead at broker (cancelled/rejected/expired/...)                       -> 'canceled'
//   still working (confirmed/queued/partially_filled)                     -> left 'placed'
export async function reconcilePlacedOrders() {
  const placed = db.prepare(
    "SELECT id, symbol, asset_type, side, qty, limit_price, placed_order_id FROM proposals WHERE status='placed' AND placed_order_id IS NOT NULL",
  ).all();

  let updated = 0;
  for (const p of placed) {
    const o = await getOrderById(p.placed_order_id, p.asset_type).catch(() => null);
    if (!o) continue; // transient lookup miss — try again next cycle

    const state = String(o.state || '').toLowerCase();
    const filledQty = Number(o.cumulative_quantity ?? 0);
    const totalQty = Number(o.quantity ?? p.qty ?? 0);

    let next = null;
    if (state === 'filled' || (totalQty > 0 && filledQty >= totalQty)) next = 'filled';
    else if (DEAD.has(state)) next = 'canceled';
    if (!next) continue; // still working (incl. partial fills) — keep it in Open orders

    const ts = now();
    if (next === 'filled') {
      const fillPrice = fillPriceOf(o, p.limit_price);
      const fillQty = filledQty > 0 ? filledQty : totalQty;
      const info = db.prepare(
        `UPDATE proposals SET status=?, decided_at=COALESCE(decided_at, ?), filled_at=?, fill_price=?, filled_qty=?, remaining_qty=?
         WHERE id=? AND status='placed'`,
      ).run(next, ts, ts, fillPrice ?? null, fillQty, p.side === 'buy' ? fillQty : null, p.id);
      if (!info.changes) continue;
      if (p.side === 'sell' && fillPrice != null) attributeRealizedPnl({ ...p, fill_price: fillPrice, filled_qty: fillQty, filled_at: ts });
    } else {
      const info = db.prepare("UPDATE proposals SET status=?, decided_at=COALESCE(decided_at, ?) WHERE id=? AND status='placed'")
        .run(next, ts, p.id);
      if (!info.changes) continue;
    }
    logEvent(next === 'filled' ? 'alert' : 'warn', 'placement',
      `Order ${next} #${p.id} ${p.symbol} (${filledQty}/${totalQty}, broker state '${state || 'unknown'}')`);
    updated++;
  }
  return updated;
}
