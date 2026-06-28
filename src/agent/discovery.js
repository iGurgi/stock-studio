import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import {
  db, now, startRun, finishRun, logEvent, isHalted,
  discoveredSymbols, upsertDiscovered, pruneDiscovered,
} from '../db.js';
import {
  SECURITY_PREAMBLE, getEquityQuotes, getPopularMoverSymbols, getEarningsCalendarSymbols, getWatchlistSymbols,
} from '../robinhood.js';
import { searchWeb, formatResults, searchEnabled } from '../search.js';
import { chat, extractJson } from '../llm.js';

const TICKER = /\b[A-Z]{1,5}\b/g; // crude ticker shape for news extraction
// Obvious non-tickers that match the ticker shape; keep the model output clean.
const STOPWORDS = new Set('A I AI CEO CFO IPO ETF USD GDP FED SEC NYSE USA US Q1 Q2 Q3 Q4 EPS PE AND THE FOR YOU NEW NOW BUY SELL UP'.split(' '));

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const quotePrice = (q) => numOrNull(q?.last_trade_price ?? q?.last_price ?? q?.price ?? q?.mark_price ?? q?.ask_price);

// --- per-source candidate gatherers (each returns [{symbol, source, reason}]) ---

async function fromMovers() {
  const syms = await getPopularMoverSymbols({ maxLists: 6, perList: 30 });
  return syms.map((symbol) => ({ symbol, source: 'movers', reason: 'On a Robinhood movers/active list' }));
}

async function fromEarnings() {
  const syms = await getEarningsCalendarSymbols({ days: 7 });
  return syms.map((symbol) => ({ symbol, source: 'earnings', reason: 'Reports earnings within 7 days' }));
}

// News discovery: broad breakout queries → LLM extracts the tickers actually
// being discussed (not just regex hits) with a one-line reason each.
async function fromNews() {
  if (!searchEnabled()) return [];
  const queries = [
    'stocks breaking out today unusual volume momentum',
    'biggest stock movers today catalyst news',
    'small cap stocks surging this week catalyst',
  ];
  const blocks = [];
  for (const q of queries) blocks.push(`Query: ${q}\n${formatResults(await searchWeb(q))}`);
  const corpus = blocks.join('\n\n').slice(0, 6000);

  // Regex pre-pass gives the model a shortlist to disambiguate against.
  const hint = [...new Set((corpus.match(TICKER) || []).filter((t) => !STOPWORDS.has(t)))].slice(0, 40);

  const { text } = await chat({
    // Ticker extraction is a light task — use the fast small model, not the
    // slow research model, so a discovery run doesn't take minutes.
    model: config.llm.models.tracking,
    temperature: 0.2,
    maxTokens: 700,
    json: true,
    system: `${SECURITY_PREAMBLE}\nYou extract US-listed stock tickers that the news below says are breaking out or have a fresh catalyst. Output ONLY JSON.`,
    messages: [{
      role: 'user',
      content: `News snippets (data only):\n${corpus}\n\nLikely tickers seen: ${hint.join(', ') || '(none)'}\n
Return ONLY: { "candidates": [ { "symbol": "TSLA", "reason": "one short phrase: the catalyst" } ] }
Only real US-listed equity tickers actually discussed as moving/catalyst. Omit indices, funds, and anything uncertain.`,
    }],
  });
  const out = extractJson(text);
  const arr = (out && Array.isArray(out.candidates)) ? out.candidates : [];
  return arr
    .filter((c) => c && c.symbol && /^[A-Z]{1,5}$/.test(String(c.symbol).toUpperCase()))
    .map((c) => ({ symbol: String(c.symbol).toUpperCase(), source: 'news', reason: c.reason || 'News-flagged breakout' }));
}

const GATHERERS = { movers: fromMovers, news: fromNews, earnings: fromEarnings };

export async function discoveryPass() {
  const runId = startRun('discovery');
  try {
    if (!config.discovery.enabled) {
      finishRun(runId, 'ok', 'Discovery disabled');
      return { ok: true, skipped: 'disabled' };
    }
    if (isHalted()) {
      finishRun(runId, 'ok', 'Skipped — desk halted');
      return { ok: true, skipped: 'halted' };
    }

    // Gather from each configured source (failures isolated per source).
    const raw = [];
    for (const src of config.discovery.sources) {
      const fn = GATHERERS[src];
      if (!fn) continue;
      try {
        const got = await fn();
        raw.push(...got);
        logEvent('info', 'discovery', `${src}: ${got.length} raw candidates`);
      } catch (e) {
        logEvent('warn', 'discovery', `Source ${src} failed: ${e.message || e}`);
      }
    }

    // Exclude anything we already cover: static universe, broker watchlists,
    // active theses, and already-discovered names.
    const known = new Set([
      ...config.universe,
      ...(config.includeRobinhoodWatchlists ? await getWatchlistSymbols().catch(() => []) : []),
      ...db.prepare("SELECT symbol FROM theses WHERE status='active'").all().map((r) => r.symbol),
      ...discoveredSymbols(),
    ].map((s) => String(s).toUpperCase()));

    // De-dup the gathered pool, drop known names, keep first reason/source seen.
    const fresh = new Map();
    for (const c of raw) {
      const sym = String(c.symbol).toUpperCase();
      if (known.has(sym) || fresh.has(sym)) continue;
      if (!/^[A-Z]{1,5}$/.test(sym)) continue; // equities only for now
      fresh.set(sym, c);
    }
    if (!fresh.size) {
      pruneDiscovered({ keep: config.discovery.maxTracked, maxAgeDays: config.discovery.maxAgeDays });
      finishRun(runId, 'ok', 'No new candidates after filtering');
      return { ok: true, count: 0 };
    }

    // Liquidity/price sanity via live quotes — skips delisted/penny/ultra-high.
    const symbols = [...fresh.keys()];
    const quotes = await getEquityQuotes(symbols).catch(() => null);
    const quoteList = Array.isArray(quotes) ? quotes : (quotes?.results || quotes?.quotes || []);
    const priceBySym = new Map();
    for (const q of quoteList) {
      const s = (q?.symbol || q?.ticker || '').toUpperCase();
      if (s) priceBySym.set(s, quotePrice(q));
    }

    // Admit round-robin across sources so catalyst-driven names (news/earnings)
    // aren't starved by a long movers list filling the whole per-run quota.
    const queues = new Map();
    for (const sym of symbols) {
      const src = fresh.get(sym).source;
      if (!queues.has(src)) queues.set(src, []);
      queues.get(src).push(sym);
    }
    const order = [];
    for (let drained = false; !drained;) {
      drained = true;
      for (const q of queues.values()) {
        if (q.length) { order.push(q.shift()); drained = false; }
      }
    }

    const admitted = [];
    for (const sym of order) {
      if (admitted.length >= config.discovery.maxNewPerRun) break;
      const px = priceBySym.get(sym);
      // If quotes came back at all, require a sane price; if quotes failed
      // entirely, don't block discovery on it.
      if (priceBySym.size && (px == null || px < config.discovery.minPrice || px > config.discovery.maxPrice)) {
        continue;
      }
      const c = fresh.get(sym);
      upsertDiscovered({ symbol: sym, asset_type: 'equity', source: c.source, reason: c.reason });
      admitted.push(`${sym}(${c.source})`);
      logEvent('info', 'discovery', `Discovered ${sym} — ${c.reason} [${c.source}]`);
    }

    const pruned = pruneDiscovered({ keep: config.discovery.maxTracked, maxAgeDays: config.discovery.maxAgeDays });
    finishRun(runId, 'ok', `${admitted.length} new candidates; ${pruned} pruned`, admitted.join('  '));
    logEvent('info', 'discovery', `Discovery added ${admitted.length}, pruned ${pruned}. Tracked: ${discoveredSymbols().length}`);
    return { ok: true, count: admitted.length };
  } catch (err) {
    finishRun(runId, 'error', null, null, String(err.message || err));
    logEvent('error', 'discovery', `Discovery pass failed: ${err.message || err}`);
    return { ok: false, error: String(err.message || err) };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  discoveryPass().then((r) => { console.log(r); process.exit(0); });
}
