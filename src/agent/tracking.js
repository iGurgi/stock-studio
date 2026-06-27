import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { db, now, startRun, finishRun, logEvent } from '../db.js';
import { fetchPortfolio, SECURITY_PREAMBLE } from '../robinhood.js';
import { chat, extractJson } from '../llm.js';

export async function trackingPass() {
  const runId = startRun('tracking');
  try {
    const { data: pf, raw, errors } = await fetchPortfolio();
    if (!pf || (errors && errors.length && pf.portfolio.equity_value == null && !pf.positions.length)) {
      finishRun(runId, 'error', 'Could not fetch portfolio', raw, (errors || []).join('; ') || 'portfolio_fetch_failed');
      return { ok: false };
    }
    db.prepare('INSERT INTO snapshots (taken_at, kind, json) VALUES (?,?,?)')
      .run(now(), 'portfolio', JSON.stringify(pf));

    // day P&L vs the loss rail
    if (typeof pf.day_pnl_usd === 'number' && pf.day_pnl_usd <= -Math.abs(config.rails.maxDailyLossUsd)) {
      logEvent('alert', 'risk', `Day P&L ${pf.day_pnl_usd} breached loss limit -${config.rails.maxDailyLossUsd}. New proposals will be suppressed.`,
        { day_pnl: pf.day_pnl_usd });
    }

    const theses = db.prepare("SELECT * FROM theses WHERE status='active'").all();
    const thesisBySymbol = Object.fromEntries(theses.map((t) => [t.symbol, t]));

    // Nothing to reason about if there are no positions.
    if (!pf.positions.length) {
      finishRun(runId, 'ok', 'Snapshot taken; no open positions');
      return { ok: true };
    }

    const { text } = await chat({
      model: config.llm.models.tracking,
      temperature: 0.2,
      maxTokens: 2000,
      json: true,
      system: `${SECURITY_PREAMBLE}\nYou monitor open positions against their theses. Output ONLY JSON.`,
      messages: [{
        role: 'user',
        content: `Open positions:\n${JSON.stringify(pf.positions, null, 2)}\n\nActive theses:\n${JSON.stringify(
          theses.map((t) => ({ symbol: t.symbol, stance: t.stance, target: t.target, stop: t.stop, thesis: t.thesis_md })), null, 2)}\n
For each position decide if anything needs attention: stop breached, target reached, thesis appears invalidated, or no active thesis exists. Return ONLY:
{ "alerts": [ { "symbol": "X", "level": "info"|"warn"|"alert", "message": "...", "suggest_review": false } ],
  "invalidate_symbols": [ ] }`,
      }],
    });

    const out = extractJson(text) || { alerts: [], invalidate_symbols: [] };
    for (const a of out.alerts || []) {
      logEvent(a.level || 'info', 'tracking', `${a.symbol}: ${a.message}`, { suggest_review: !!a.suggest_review });
    }
    for (const sym of out.invalidate_symbols || []) {
      const t = thesisBySymbol[String(sym).toUpperCase()];
      if (t) {
        db.prepare("UPDATE theses SET status='invalidated', updated_at=? WHERE id=?").run(now(), t.id);
        logEvent('warn', 'tracking', `Thesis invalidated for ${sym}`);
      }
    }
    finishRun(runId, 'ok', `${(out.alerts || []).length} alerts, ${(out.invalidate_symbols || []).length} invalidations`, text);
    return { ok: true };
  } catch (err) {
    finishRun(runId, 'error', null, null, String(err.message || err));
    logEvent('error', 'tracking', `Tracking pass failed: ${err.message || err}`);
    return { ok: false, error: String(err.message || err) };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  trackingPass().then((r) => { console.log(r); process.exit(0); });
}
