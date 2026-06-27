import { cbRequest } from './coinbase/rest.js';

// Coinbase Advanced Trade broker module. Deterministic — our code calls the
// REST endpoints directly (no LLM in the loop), mirroring robinhood.js. Handles
// crypto (product ids like "BTC-USD"). Order placement lands in Phase 3.

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Raw account/balance list (one entry per currency: BTC, ETH, USD, …). */
export async function getAccounts() {
  const r = await cbRequest('GET', '/api/v3/brokerage/accounts', { query: { limit: 250 } });
  return r.accounts || [];
}

/** Current price for one product, e.g. "BTC-USD". */
export async function getProductPrice(productId) {
  const r = await cbRequest('GET', `/api/v3/brokerage/products/${encodeURIComponent(productId)}`);
  return numOrNull(r.price);
}

/** Quotes for the research/proposal passes. symbols like ["BTC-USD"]. */
export async function getQuotes(symbols) {
  const out = [];
  for (const s of symbols || []) {
    try { out.push({ symbol: s, price: await getProductPrice(s) }); }
    catch (e) { out.push({ symbol: s, price: null, error: String(e.message || e) }); }
  }
  return out;
}

/**
 * Normalized portfolio snapshot for the Coinbase (crypto) side, same shape the
 * dashboard/tracking expect from robinhood.js fetchPortfolio().
 */
export async function fetchPortfolio() {
  const bundle = {};
  const errors = [];
  let accounts = [];
  try { accounts = await getAccounts(); bundle.accounts = accounts; }
  catch (e) { errors.push(`accounts: ${e.message}`); }

  let cash = 0;
  let cryptoValue = 0;
  const positions = [];
  for (const a of accounts) {
    const ccy = a.currency;
    const avail = numOrNull(a.available_balance?.value) ?? 0;
    const held = numOrNull(a.hold?.value) ?? 0;
    const qty = avail + held;
    if (qty <= 0) continue;
    if (ccy === 'USD' || ccy === 'USDC') { cash += qty; continue; }
    // crypto holding — price it
    let mark = null;
    try { mark = await getProductPrice(`${ccy}-USD`); } catch (e) { errors.push(`${ccy} price: ${e.message}`); }
    const marketValue = mark != null ? qty * mark : null;
    if (marketValue != null) cryptoValue += marketValue;
    positions.push({
      symbol: `${ccy}-USD`,
      asset_type: 'crypto',
      qty,
      avg_cost: null,       // not available from balances; needs fills ledger (later)
      mark,
      market_value: marketValue,
      unrealized_pnl: null,
      venue: 'coinbase',
    });
  }

  const data = {
    portfolio: {
      account_value: cash + cryptoValue,
      equity_value: null,        // n/a on Coinbase (crypto venue)
      buying_power: cash,        // USD/USDC available is the spendable figure
      cash,
      crypto_value: cryptoValue,
    },
    day_pnl_usd: null,
    positions,
    realized_pnl_30d_usd: null,
  };
  return { data, bundle, raw: JSON.stringify(bundle).slice(0, 4000), errors };
}

// ---- orders (Phase 3) -----------------------------------------------------
export async function reviewOrder() {
  throw new Error('Coinbase reviewOrder not implemented yet (Phase 3)');
}
export async function placeApprovedOrder() {
  throw new Error('Coinbase placeApprovedOrder not implemented yet (Phase 3)');
}
