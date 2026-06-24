import { config } from '../config.js';
import { db, now, startRun, finishRun, logEvent } from '../db.js';
import { callClaude, extractJson, allText } from '../anthropic.js';
import { SECURITY_PREAMBLE } from '../robinhood.js';

function upsertThesis(t) {
  const existing = db.prepare('SELECT id FROM theses WHERE symbol=? AND status="active"').get(t.symbol);
  const ts = now();
  if (existing) {
    db.prepare(`UPDATE theses SET stance=?, conviction=?, thesis_md=?, target=?, stop=?, asset_type=?, updated_at=? WHERE id=?`)
      .run(t.stance, t.conviction, t.thesis_md, t.target ?? null, t.stop ?? null, t.asset_type || 'equity', ts, existing.id);
    return existing.id;
  }
  const info = db.prepare(`INSERT INTO theses (symbol, asset_type, stance, conviction, thesis_md, target, stop, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(t.symbol, t.asset_type || 'equity', t.stance, t.conviction, t.thesis_md, t.target ?? null, t.stop ?? null, ts, ts);
  return Number(info.lastInsertRowid);
}

export async function researchPass() {
  const runId = startRun('research');
  try {
    const universe = [...config.universe];
    const resp = await callClaude({
      model: config.anthropic.models.research,
      useRobinhood: true,
      useWebSearch: true,
      allowedTools: [
        'get_equity_quotes', 'get_equity_fundamentals', 'get_earnings_results',
        'get_equity_historicals', 'get_index_quotes', 'search',
        config.includeRobinhoodWatchlists ? 'get_watchlists' : null,
        config.includeRobinhoodWatchlists ? 'get_watchlist_items' : null,
      ].filter(Boolean),
      temperature: 0.3,
      maxTokens: 8000,
      system: `${SECURITY_PREAMBLE}
You are running a periodic research sweep. For each symbol, use Robinhood data tools for quotes, fundamentals,
earnings, and price history, and use web_search for fresh news/catalysts. Form or update a concise thesis.
Be skeptical and specific; cite the catalyst, not vibes. Conviction 1 (weak) to 5 (strong).
Return ONLY JSON.`,
      messages: [{
        role: 'user',
        content: `Research universe: ${universe.join(', ')}${config.includeRobinhoodWatchlists ? ' plus everything on my Robinhood watchlists' : ''}.
For each symbol produce a thesis. Crypto symbols look like BTC-USD.
Return ONLY:
{
  "theses": [
    { "symbol": string, "asset_type": "equity"|"etf"|"crypto",
      "stance": "bull"|"bear"|"neutral", "conviction": 1-5,
      "thesis_md": "2-4 sentence thesis with the concrete catalyst and the level/condition that would invalidate it",
      "target": number|null, "stop": number|null }
  ],
  "notes": [ { "symbol": string, "body_md": "one notable fresh data point or news item" } ]
}`,
      }],
    });

    const out = extractJson(resp);
    if (!out || !Array.isArray(out.theses)) {
      finishRun(runId, 'error', 'No parseable theses', allText(resp), 'parse_failed');
      logEvent('error', 'research', 'Research pass returned no parseable theses');
      return { ok: false };
    }
    let n = 0;
    for (const t of out.theses) {
      if (!t.symbol || !t.thesis_md) continue;
      t.symbol = String(t.symbol).toUpperCase();
      t.conviction = Math.max(1, Math.min(5, Number(t.conviction) || 3));
      upsertThesis(t);
      n++;
    }
    for (const note of out.notes || []) {
      if (!note.body_md) continue;
      db.prepare('INSERT INTO notes (symbol, run_id, kind, body_md, created_at) VALUES (?,?,?,?,?)')
        .run(note.symbol ? String(note.symbol).toUpperCase() : null, runId, 'research', note.body_md, now());
    }
    finishRun(runId, 'ok', `Updated ${n} theses`, allText(resp));
    logEvent('info', 'research', `Research pass updated ${n} theses`);
    return { ok: true, count: n };
  } catch (err) {
    finishRun(runId, 'error', null, null, String(err.message || err));
    logEvent('error', 'research', `Research pass failed: ${err.message || err}`);
    return { ok: false, error: String(err.message || err) };
  }
}

// allow `node src/agent/research.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  researchPass().then((r) => { console.log(r); process.exit(0); });
}
