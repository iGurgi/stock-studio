import { db, logEvent, now } from '../db.js';
import { getOrderById } from '../robinhood.js';

// Broker order states that are terminal in our model.
const DEAD = new Set(['cancelled', 'canceled', 'rejected', 'expired', 'failed', 'voided']);

// Reconcile every proposal we left in `placed` against its real broker state, so
// a fill or an out-of-band cancel is reflected back instead of lingering in the
// Open orders panel forever. Read-only at the broker; only updates our own rows.
//
//   filled at broker (cumulative_quantity >= quantity, or state 'filled') -> 'filled'
//   dead at broker (cancelled/rejected/expired/...)                       -> 'canceled'
//   still working (confirmed/queued/partially_filled)                     -> left 'placed'
export async function reconcilePlacedOrders() {
  const placed = db.prepare(
    "SELECT id, symbol, asset_type, qty, placed_order_id FROM proposals WHERE status='placed' AND placed_order_id IS NOT NULL",
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

    const info = db.prepare("UPDATE proposals SET status=?, decided_at=COALESCE(decided_at, ?) WHERE id=? AND status='placed'")
      .run(next, now(), p.id);
    if (!info.changes) continue;
    logEvent(next === 'filled' ? 'alert' : 'warn', 'placement',
      `Order ${next} #${p.id} ${p.symbol} (${filledQty}/${totalQty}, broker state '${state || 'unknown'}')`);
    updated++;
  }
  return updated;
}
