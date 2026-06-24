import 'dotenv/config';

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
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    models: {
      research: process.env.MODEL_RESEARCH || 'claude-sonnet-4-6',
      proposal: process.env.MODEL_PROPOSAL || 'claude-opus-4-8',
      placement: process.env.MODEL_PLACEMENT || 'claude-sonnet-4-6',
    },
  },
  robinhood: {
    mcpUrl: process.env.ROBINHOOD_MCP_URL || 'https://agent.robinhood.com/mcp/trading',
    mcpToken: process.env.ROBINHOOD_MCP_TOKEN || '',
    account: process.env.ROBINHOOD_ACCOUNT || '',
  },
  universe: list(process.env.WATCH_UNIVERSE),
  includeRobinhoodWatchlists: bool(process.env.INCLUDE_ROBINHOOD_WATCHLISTS, true),
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
  if (!config.anthropic.apiKey) problems.push('ANTHROPIC_API_KEY is missing');
  if (!config.robinhood.mcpToken) problems.push('ROBINHOOD_MCP_TOKEN is missing (agent cannot reach Robinhood)');
  if (!config.robinhood.account) problems.push('ROBINHOOD_ACCOUNT is missing');
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
