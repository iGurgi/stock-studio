import { pathToFileURL } from 'node:url';
import { config, equitiesOpen } from '../config.js';
import { db, now, startRun, finishRun, logEvent, isHalted, proposalsToday } from '../db.js';
import { fetchPortfolio, reviewOrder, getEquityQuotes, getFundamentals, SECURITY_PREAMBLE } from '../robinhood.js';
import { chat, extractJson } from '../llm.js';

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

    const { data: pf } = await fetchPortfolio();
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
you never place orders. Output ONLY JSON.`,
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
    let written = 0;
    for (const c of candidates.slice(0, remainingToday)) {
      if (!c.symbol || !c.side || !c.qty) continue;
      c.symbol = String(c.symbol).toUpperCase();
      c.asset_type = c.asset_type || 'equity';

      const rc = railCheck(c, pf);
      if (!rc.ok) {
        logEvent('warn', 'proposal', `Rejected candidate ${c.symbol}: ${rc.reason}`);
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

      db.prepare(`INSERT INTO proposals
        (created_at, symbol, asset_type, side, order_type, qty, limit_price, time_in_force, est_cost_usd, rationale_md, review_json, risk_json, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending')`)
        .run(now(), c.symbol, c.asset_type, c.side, c.order_type || 'limit', c.qty,
          c.limit_price ?? null, c.time_in_force || 'gfd', c.est_cost_usd ?? null,
          c.rationale_md || '', review ? JSON.stringify(review) : null, JSON.stringify(rc.risk));
      written++;
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  proposalPass().then((r) => { console.log(r); process.exit(0); });
}
