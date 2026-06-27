import { config } from './config.js';

// Pluggable web search for the research pass. Replaces Anthropic's hosted
// web_search. Returns a normalized list of { title, url, snippet }. When no
// provider is configured it returns [] so research still runs (model-only).

export function searchEnabled() {
  return config.search.provider && config.search.provider !== 'none';
}

async function tavily(query, n) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: config.search.apiKey,
      query,
      max_results: n,
      search_depth: 'basic',
      topic: 'news',
    }),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

async function brave(query, n) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(n));
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': config.search.apiKey },
  });
  if (!res.ok) throw new Error(`brave ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
}

async function searxng(query, n) {
  const url = new URL('/search', config.search.baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`searxng ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.results || []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

/**
 * @param {string} query
 * @returns {Promise<Array<{title:string,url:string,snippet:string}>>}
 */
export async function searchWeb(query) {
  if (!searchEnabled()) return [];
  const n = config.search.maxResults;
  try {
    switch (config.search.provider) {
      case 'tavily': return await tavily(query, n);
      case 'brave': return await brave(query, n);
      case 'searxng': return await searxng(query, n);
      default: return [];
    }
  } catch (e) {
    // Search is best-effort — never fail a research pass because search broke.
    return [{ title: '(search error)', url: '', snippet: String(e.message || e) }];
  }
}

/** Compact text block of results for stuffing into a prompt. */
export function formatResults(results) {
  if (!results?.length) return '(no web results)';
  return results
    .map((r, i) => `[${i + 1}] ${r.title || ''}\n${r.url || ''}\n${(r.snippet || '').slice(0, 300)}`)
    .join('\n\n');
}
