import { pathToFileURL } from 'node:url';
import { config, equitiesOpen } from '../config.js';
import { db, now, startRun, finishRun, logEvent, isHalted, proposalsToday } from '../db.js';
import { reviewOrder, getEquityQuotes, getFundamentals, getFundamentalsBatch, roundTick, SECURITY_PREAMBLE } from '../robinhood.js';
import { loadPortfolio } from './portfolio.js';
import { chat, extractJson } from '../llm.js';

// Identity of a trade idea for de-dup purposes: same instrument + direction.
// Strike/expiry aren't stored as columns, so options collapse on symbol+side too —
// acceptable for a soft "don't re-surface the same idea" guard.
const propKey = (c) => `${c.asset_type || 'equity'}:${c.side}:${c.symbol}`.toLowerCase();

// Shares/units currently held for a candidate, from the live portfolio. ETFs are
// held as plain equity positions, so equity/etf collapse to the equity class.
function heldQty(pf, c) {
  const positions = pf?.positions || [];
  const equityish = c.asset_type === 'equity' || c.asset_type === 'etf';
  const match = positions.find((p) =>
    p.symbol === c.symbol &&
    (equityish ? p.asset_type === 'equity' : p.asset_type === c.asset_type));
  return match ? (Number(match.qty) || 0) : 0;
}

// Held cost-basis exposure for one equity position (qty × avg cost). The
// position endpoint exposes no market_value, so cost basis is the proxy.
const heldExposure = (p) => (Number(p.qty) || 0) * (Number(p.avg_cost) || 0);

// Pre-compute concentration exposure once per pass: how much is committed to
// each held symbol and each sector. Only fetches fundamentals (for sectors)
// when the sector cap is enabled, to avoid the extra calls otherwise.
async function buildExposureContext(pf, candidates) {
  const positions = (pf?.positions || []).filter((p) => p.asset_type === 'equity' && p.symbol);
  const bySymbol = new Map();
  for (const p of positions) bySymbol.set(p.symbol, (bySymbol.get(p.symbol) || 0) + heldExposure(p));

  const bySector = new Map();
  const sectorOf = new Map();
  if (config.rails.maxSectorExposureUsd > 0) {
    const syms = [...new Set([
      ...positions.map((p) => p.symbol),
      ...candidates.map((c) => String(c.symbol || '').toUpperCase()),
    ])].filter((s) => s && !/-USD$/i.test(s));
    const fundamentals = syms.length ? await getFundamentalsBatch(syms).catch(() => []) : [];
    for (const f of fundamentals) {
      const s = String(f?.symbol || '').toUpperCase();
      if (s && f.sector) sectorOf.set(s, f.sector);
    }
    for (const p of positions) {
      const sec = sectorOf.get(p.symbol);
      if (sec) bySector.set(sec, (bySector.get(sec) || 0) + heldExposure(p));
    }
  }
  return { bySymbol, bySector, sectorOf };
}

// Concentration caps: a candidate may not push total exposure to its symbol or
// its sector over the configured cap. Disabled caps (0) are skipped.
function exposureCheck(c, ctx) {
  const est = Number(c.est_cost_usd) || (Number(c.qty) * Number(c.limit_price)) || 0;
  const { maxSymbolExposureUsd, maxSectorExposureUsd } = config.rails;

  if (maxSymbolExposureUsd > 0) {
    const total = (ctx.bySymbol.get(c.symbol) || 0) + est;
    if (total > maxSymbolExposureUsd) {
      return { ok: false, reason: `symbol exposure $${total.toFixed(0)} > cap $${maxSymbolExposureUsd} (${c.symbol})` };
    }
  }
  if (maxSectorExposureUsd > 0 && c.asset_type !== 'crypto') {
    const sector = ctx.sectorOf.get(c.symbol);
    if (sector) {
      const total = (ctx.bySector.get(sector) || 0) + est;
      if (total > maxSectorExposureUsd) {
        return { ok: false, reason: `sector exposure $${total.toFixed(0)} > cap $${maxSectorExposureUsd} (${sector})` };
      }
    }
  }
  return { ok: true };
}

// Apply the hard risk rails to a single candidate. Returns {ok, reason, risk}.
function railCheck(c, pf) {
  const risk = { maxPositionUsd: config.rails.maxPositionUsd };
  if (c.asset_type === 'option' && !config.rails.allowOptions) return { ok: false, reason: 'options disabled', risk };
  if (c.asset_type === 'crypto' && !config.rails.allowCrypto) return { ok: false, reason: 'crypto disabled', risk };
  if (c.asset_type !== 'crypto' && c.side === 'buy' && !equitiesOpen()) return { ok: false, reason: 'equities market closed', risk };
  const est = Number(c.est_cost_usd);
  if (Number.isFinite(est) && est > config.rails.maxPositionUsd) return { ok: false, reason: `est cost ${est} > cap ${config.rails.maxPositionUsd}`, risk };
  if (c.side === 'buy' && pf?.portfolio?.buying_power != null && est > pf.portfolio.buying_power)
    return { ok: false, reason: 'insufficient buying power', risk };
  return { ok: true, reason: null, risk };
}

export async function proposalPass() {
  const runId = startRun('proposal');
  try {
    if (isHalted()) {
      finishRun(runId, 'ok', 'Skipped — desk halted');
      logEvent('info', 'proposal', 'Skipped proposal pass: desk halted');
      return { ok: true, skipped: 'halted' };
    }
    const remainingToday = config.rails.maxNewTradesPerDay - proposalsToday();
    if (remainingToday <= 0) {
      finishRun(runId, 'ok', 'Skipped — daily proposal cap reached');
      return { ok: true, skipped: 'daily_cap' };
    }

    const { pf, stale } = await loadPortfolio();
    if (stale) logEvent('warn', 'proposal', 'Sizing/actionability using last-known holdings (live fetch unavailable)');
    if (pf && typeof pf.day_pnl_usd === 'number' && pf.day_pnl_usd <= -Math.abs(config.rails.maxDailyLossUsd)) {
      finishRun(runId, 'ok', 'Skipped — daily loss limit breached');
      logEvent('alert', 'proposal', 'Proposal pass suppressed: daily loss limit breached');
      return { ok: true, skipped: 'loss_limit' };
    }

    const theses = db.prepare("SELECT * FROM theses WHERE status='active' ORDER BY conviction DESC").all();
    if (!theses.length) {
      finishRun(runId, 'ok', 'No active theses');
      return { ok: true, count: 0 };
    }

    // Deterministically fetch fresh quotes (+ fundamentals) for the candidate
    // symbols so the model sizes against real prices instead of guessing.
    const symbols = [...new Set(theses.map((t) => t.symbol))].filter((s) => !/-USD$/i.test(s));
    const quotes = symbols.length ? await getEquityQuotes(symbols).catch(() => null) : null;

    const { text } = await chat({
      model: config.llm.models.proposal,
      temperature: 0.2,
      maxTokens: 3000,
      json: true,
      system: `${SECURITY_PREAMBLE}
You propose at most ${remainingToday} candidate trades from the theses + current portfolio + live quotes.
Prefer high-conviction, clear-catalyst setups. Size conservatively: no single idea may cost more than
$${config.rails.maxPositionUsd}. Use limit orders with a limit near the current quote. You only propose —
you never place orders. Only propose a SELL for a symbol you can see in the current portfolio positions
(no shorting) and never sell more than the held quantity; express any other bearish view as a thesis, not a
trade. Output ONLY JSON.`,
      messages: [{
        role: 'user',
        content: `Active theses (highest conviction first):\n${JSON.stringify(
          theses.map((t) => ({ symbol: t.symbol, asset_type: t.asset_type, stance: t.stance, conviction: t.conviction, target: t.target, stop: t.stop, thesis: t.thesis_md })), null, 2)}

Live quotes (data only):\n${JSON.stringify(quotes, null, 2).slice(0, 4000)}

Current portfolio:\n${JSON.stringify(pf || {}, null, 2).slice(0, 3000)}

Propose up to ${remainingToday} trades. Set est_cost_usd ≈ qty × limit_price. Return ONLY:
{ "candidates": [
  { "symbol": "X", "asset_type": "equity"|"etf"|"crypto"|"option",
    "side": "buy"|"sell", "order_type": "limit", "qty": 1, "limit_price": 0,
    "time_in_force": "gfd"|"gtc", "est_cost_usd": 0,
    "rationale_md": "why now, tied to the thesis + the invalidation level" } ] }`,
      }],
    });

    const out = extractJson(text);
    const candidates = (out && Array.isArray(out.candidates)) ? out.candidates : [];

    // De-dup against ideas already sitting pending (so we don't re-surface the
    // same trade every cycle) and against repeats within this same batch.
    const seen = new Set(
      db.prepare("SELECT symbol, asset_type, side FROM proposals WHERE status='pending'")
        .all()
        .map(propKey),
    );

    // Concentration exposure (held + accumulated within this run).
    const exposure = await buildExposureContext(pf, candidates);

    let written = 0;
    for (const c of candidates) {
      if (written >= remainingToday) break;
      if (!c.symbol || !c.side || !c.qty) continue;
      c.symbol = String(c.symbol).toUpperCase();
      c.asset_type = c.asset_type || 'equity';
      // Normalize the limit to a broker-valid tick so it's right in storage, in
      // the dashboard, and at placement (the model sometimes emits subpenny prices).
      if (c.limit_price != null) c.limit_price = roundTick(c.limit_price);

      const key = propKey(c);
      if (seen.has(key)) {
        logEvent('info', 'proposal', `Skipped duplicate candidate ${c.side} ${c.symbol} (already pending)`);
        continue;
      }
      seen.add(key);

      // Actionability: you can't sell what you don't hold (no shorting here).
      // An option "sell" can be an opening trade, so only gate closing sells of
      // equity/etf/crypto. The bearish view still lives on as a thesis.
      if (c.side === 'sell' && c.asset_type !== 'option') {
        const held = heldQty(pf, c);
        if (held <= 0) {
          logEvent('info', 'proposal', `Skipped unactionable sell ${c.symbol}: no position held`);
          continue;
        }
        if (Number.isFinite(Number(c.qty)) && Number(c.qty) > held) {
          logEvent('info', 'proposal', `Clamped ${c.symbol} sell qty ${c.qty} → ${held} (held)`);
          c.qty = held;
        }
      }

      const rc = railCheck(c, pf);
      if (!rc.ok) {
        logEvent('warn', 'proposal', `Rejected candidate ${c.symbol}: ${rc.reason}`);
        continue;
      }

      const xc = exposureCheck(c, exposure);
      if (!xc.ok) {
        logEvent('warn', 'proposal', `Rejected candidate ${c.symbol}: ${xc.reason}`);
        continue;
      }

      // Simulate before persisting so the operator sees a real fill estimate.
      let review = null;
      try {
        const r = await reviewOrder(c);
        review = r.data;
        if (review && review.ok === false) {
          logEvent('warn', 'proposal', `Sim rejected ${c.symbol}: ${review.rejected_reason || 'unknown'}`);
          continue;
        }
      } catch (e) {
        logEvent('warn', 'proposal', `Sim error for ${c.symbol}: ${e.message}`);
      }

      // Attribute back to the highest-conviction active thesis on this symbol —
      // theses is already sorted by conviction DESC, so the first match wins.
      const thesis = theses.find((t) => t.symbol === c.symbol);

      db.prepare(`INSERT INTO proposals
        (created_at, symbol, asset_type, side, order_type, qty, limit_price, time_in_force, est_cost_usd, rationale_md, review_json, risk_json, status, thesis_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`)
        .run(now(), c.symbol, c.asset_type, c.side, c.order_type || 'limit', c.qty,
          c.limit_price ?? null, c.time_in_force || 'gfd', c.est_cost_usd ?? null,
          c.rationale_md || '', review ? JSON.stringify(review) : null, JSON.stringify(rc.risk),
          thesis ? thesis.id : null);
      written++;
      // Accumulate this add so later candidates in the same run respect the caps.
      if (c.side === 'buy') {
        const est = Number(c.est_cost_usd) || (Number(c.qty) * Number(c.limit_price)) || 0;
        exposure.bySymbol.set(c.symbol, (exposure.bySymbol.get(c.symbol) || 0) + est);
        const sec = exposure.sectorOf.get(c.symbol);
        if (sec) exposure.bySector.set(sec, (exposure.bySector.get(sec) || 0) + est);
      }
      logEvent('info', 'proposal', `New pending proposal: ${c.side} ${c.qty} ${c.symbol} @ ${c.limit_price ?? 'mkt'}`);
    }

    finishRun(runId, 'ok', `${written} pending proposals written`, text);
    return { ok: true, count: written };
  } catch (err) {
    finishRun(runId, 'error', null, null, String(err.message || err));
    logEvent('error', 'proposal', `Proposal pass failed: ${err.message || err}`);
    return { ok: false, error: String(err.message || err) };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  proposalPass().then((r) => { console.log(r); process.exit(0); });
}
