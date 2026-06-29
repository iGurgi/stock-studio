import 'dotenv/config';
import { getKv, setKv } from './db.js';

// --- runtime-editable secrets --------------------------------------------
// These three can be entered+saved from the dashboard and persist in the DB
// (which lives on the studio-data volume, so they survive restarts/logins).
// A saved DB value always wins; the matching env var is only a fallback.
const SECRETS = {
  robinhoodMcpToken: { kv: 'secret:robinhood_mcp_token', env: 'ROBINHOOD_MCP_TOKEN' },
  // OAuth refresh material, saved by scripts/get-robinhood-token.mjs so the
  // access token can be renewed automatically when it expires (see mcp/robinhood-auth.js).
  robinhoodRefreshToken: { kv: 'secret:robinhood_refresh_token', env: 'ROBINHOOD_REFRESH_TOKEN' },
  robinhoodOauthClientId: { kv: 'secret:robinhood_oauth_client_id', env: 'ROBINHOOD_OAUTH_CLIENT_ID' },
  robinhoodTokenEndpoint: { kv: 'secret:robinhood_token_endpoint', env: 'ROBINHOOD_TOKEN_ENDPOINT' },
  robinhoodAccount: { kv: 'secret:robinhood_account', env: 'ROBINHOOD_ACCOUNT' },
  llmApiKey: { kv: 'secret:llm_api_key', env: 'LLM_API_KEY' },
  searchApiKey: { kv: 'secret:search_api_key', env: 'SEARCH_API_KEY' },
  coinbaseApiKeyName: { kv: 'secret:coinbase_api_key_name', env: 'COINBASE_API_KEY_NAME' },
  coinbaseApiSecret: { kv: 'secret:coinbase_api_secret', env: 'COINBASE_API_SECRET' },
};

function resolveSecret(name) {
  const spec = SECRETS[name];
  const fromDb = getKv(spec.kv, '');
  if (fromDb) return { value: fromDb, source: 'db' };
  const fromEnv = process.env[spec.env] || '';
  return { value: fromEnv, source: fromEnv ? 'env' : 'unset' };
}

/** Current resolved value of a runtime secret (DB override, else env). */
export function getSecret(name) {
  return resolveSecret(name).value;
}

/** Persist (or clear, when value is empty) a runtime secret in the DB. */
export function setSecret(name, value) {
  if (!SECRETS[name]) throw new Error(`unknown secret: ${name}`);
  setKv(SECRETS[name].kv, value == null ? '' : String(value).trim());
}

function mask(value) {
  if (!value) return null;
  return value.length <= 4 ? '••••' : '••••' + value.slice(-4);
}

/** Masked status of every runtime secret — safe to expose to the dashboard. */
export function secretsStatus() {
  const out = {};
  for (const name of Object.keys(SECRETS)) {
    const { value, source } = resolveSecret(name);
    out[name] = { set: !!value, source, preview: mask(value) };
  }
  return out;
}

function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export const config = {
  // Local (or any OpenAI-compatible) LLM backend — replaces the Anthropic API.
  llm: {
    baseUrl: (process.env.LLM_BASE_URL || 'http://ollama:11434/v1').replace(/\/+$/, ''),
    // Optional bearer for gated gateways; Ollama ignores it.
    get apiKey() { return getSecret('llmApiKey'); },
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 240000), // per-request ceiling (qwen is slow)
    retries: num(process.env.LLM_RETRIES, 1),           // retries on transient network failure
    models: {
      research: process.env.MODEL_RESEARCH || 'qwen2.5:14b',
      proposal: process.env.MODEL_PROPOSAL || 'qwen2.5:14b',
      tracking: process.env.MODEL_TRACKING || 'qwen2.5:14b',
    },
  },
  // Pluggable web search for the research pass. provider: none|tavily|brave|searxng
  search: {
    provider: (process.env.SEARCH_PROVIDER || 'none').toLowerCase(),
    get apiKey() { return getSecret('searchApiKey'); },
    baseUrl: process.env.SEARCH_BASE_URL || '', // SearXNG instance URL
    maxResults: num(process.env.SEARCH_MAX_RESULTS, 5),
    recencyDays: num(process.env.SEARCH_RECENCY_DAYS, 14), // news lookback window
  },
  robinhood: {
    mcpUrl: process.env.ROBINHOOD_MCP_URL || 'https://agent.robinhood.com/mcp/trading',
    get mcpToken() { return getSecret('robinhoodMcpToken'); },
    get account() { return getSecret('robinhoodAccount'); },
  },
  coinbase: {
    enabled: bool(process.env.COINBASE_ENABLED, false),
    get apiKeyName() { return getSecret('coinbaseApiKeyName'); },
    get apiSecret() { return getSecret('coinbaseApiSecret'); },
  },
  // Which venue handles crypto (-USD) orders: 'robinhood' | 'coinbase'
  cryptoVenue: (process.env.CRYPTO_VENUE || 'robinhood').toLowerCase(),
  universe: list(process.env.WATCH_UNIVERSE),
  includeRobinhoodWatchlists: bool(process.env.INCLUDE_ROBINHOOD_WATCHLISTS, true),
  // Breakout discovery: pull fresh candidate symbols from movers/news/earnings
  // into the research universe so the desk isn't blind to names off the watchlist.
  discovery: {
    enabled: bool(process.env.DISCOVERY_ENABLED, true),
    sources: list(process.env.DISCOVERY_SOURCES || 'movers,news,earnings').map((s) => s.toLowerCase()),
    maxNewPerRun: num(process.env.DISCOVERY_MAX_NEW, 8),   // new names admitted per run
    maxTracked: num(process.env.DISCOVERY_MAX_TRACKED, 30), // ceiling on the discovered universe
    maxAgeDays: num(process.env.DISCOVERY_MAX_AGE_DAYS, 14), // prune names not re-seen within
    minPrice: num(process.env.DISCOVERY_MIN_PRICE, 1),     // penny floor
    maxPrice: num(process.env.DISCOVERY_MAX_PRICE, 2000),  // skip ultra-high-priced names
    minDollarVol: num(process.env.DISCOVERY_MIN_DOLLAR_VOL, 1_000_000), // avg daily $ volume floor (liquidity)
  },
  rails: {
    maxPositionUsd: num(process.env.MAX_POSITION_USD, 2000),
    maxNewTradesPerDay: num(process.env.MAX_NEW_TRADES_PER_DAY, 5),
    maxDailyLossUsd: num(process.env.MAX_DAILY_LOSS_USD, 500),
    allowOptions: bool(process.env.ALLOW_OPTIONS, true),
    allowCrypto: bool(process.env.ALLOW_CRYPTO, true),
    marketOpenEt: process.env.MARKET_OPEN_ET || '09:30',
    marketCloseEt: process.env.MARKET_CLOSE_ET || '16:00',
  },
  cadence: {
    researchMin: num(process.env.RESEARCH_EVERY_MIN, 60),
    trackingMin: num(process.env.TRACKING_EVERY_MIN, 15),
    proposalMin: num(process.env.PROPOSAL_EVERY_MIN, 30),
    discoveryMin: num(process.env.DISCOVERY_EVERY_MIN, 120),
  },
  server: {
    port: num(process.env.PORT, 8787),
    host: process.env.HOST || '127.0.0.1',
    controlToken: process.env.CONTROL_TOKEN || '',
  },
  placementEnabled: bool(process.env.PLACEMENT_ENABLED, false),
};

export function assertConfig() {
  const problems = [];
  if (!config.llm.baseUrl) problems.push('LLM_BASE_URL is missing (no reasoning backend)');
  if (!config.robinhood.mcpToken) problems.push('ROBINHOOD_MCP_TOKEN is missing (agent cannot reach Robinhood)');
  if (!config.robinhood.account) problems.push('ROBINHOOD_ACCOUNT is missing');
  if (config.search.provider !== 'none') {
    if ((config.search.provider === 'tavily' || config.search.provider === 'brave') && !config.search.apiKey)
      problems.push(`SEARCH_PROVIDER=${config.search.provider} but no search API key set`);
    if (config.search.provider === 'searxng' && !config.search.baseUrl)
      problems.push('SEARCH_PROVIDER=searxng but SEARCH_BASE_URL is unset');
  }
  if (!config.server.controlToken || config.server.controlToken === 'change-me-to-a-long-random-string')
    problems.push('CONTROL_TOKEN is unset or default — dashboard write actions will be insecure');
  return problems;
}

// True if equities markets are (roughly) open right now, US/Eastern.
export function equitiesOpen(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return false;
  const [oh, om] = config.rails.marketOpenEt.split(':').map(Number);
  const [ch, cm] = config.rails.marketCloseEt.split(':').map(Number);
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= oh * 60 + om && mins <= ch * 60 + cm;
}
