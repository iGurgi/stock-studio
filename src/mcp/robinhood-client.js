import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../config.js';
import { refreshAccessToken } from './robinhood-auth.js';

// Deterministic MCP client for the Robinhood trading server. OUR code decides
// which tools to call and calls them directly — no LLM in the loop. This is the
// safety-critical replacement for Anthropic's server-side MCP connector.

let _client = null;
let _connecting = null;

async function connect() {
  const token = config.robinhood.mcpToken;
  if (!token) throw new Error('ROBINHOOD_MCP_TOKEN not set — save it in the dashboard Credentials panel');
  const transport = new StreamableHTTPClientTransport(new URL(config.robinhood.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'stock-studio', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  transport.onclose = () => { if (_client === client) _client = null; };
  _client = client;
  return client;
}

async function getClient() {
  if (_client) return _client;
  if (!_connecting) _connecting = connect().finally(() => { _connecting = null; });
  return _connecting;
}

/**
 * Call a single Robinhood MCP tool and return its parsed result.
 * @returns {Promise<{isError:boolean, text:string, data:any}>}
 */
export async function callTool(name, args = {}, _retried = false) {
  const client = await getClient();
  let resp;
  try {
    resp = await client.callTool({ name, arguments: args });
  } catch (e) {
    _client = null; // drop a possibly-dead connection so the next call reconnects
    const msg = String(e?.message || e);
    if (/401|403|unauthor/i.test(msg)) {
      // Token likely expired — try a one-shot OAuth refresh, then retry with the
      // new token (the dropped connection above reconnects using it).
      if (!_retried) {
        const refreshed = await refreshAccessToken();
        if (refreshed) return callTool(name, args, true);
      }
      throw new Error(`Robinhood MCP auth failed — token expired and auto-refresh ${_retried ? 'did not help' : 'is unavailable'}; re-mint with scripts/get-robinhood-token.mjs (${msg})`);
    }
    throw e;
  }
  const text = (resp.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('\n');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* leave as text */ }
  // Robinhood wraps every payload as { data, guide }. Unwrap to the payload and
  // surface the human-readable `guide` separately.
  let data = parsed;
  let guide = null;
  if (parsed && typeof parsed === 'object' && 'data' in parsed && 'guide' in parsed) {
    data = parsed.data;
    guide = parsed.guide;
  }
  return { isError: !!resp.isError, text, data, guide };
}

/** List available tools (names + input schemas). Handy for diagnostics. */
export async function listTools() {
  const client = await getClient();
  const { tools } = await client.listTools();
  return tools;
}

/** Convenience: call a tool and throw on tool-level error, returning parsed data. */
export async function callToolOrThrow(name, args = {}) {
  const r = await callTool(name, args);
  if (r.isError) throw new Error(`Robinhood tool ${name} failed: ${r.text.slice(0, 300)}`);
  return r.data ?? r.text;
}

export async function close() {
  if (_client) { await _client.close().catch(() => {}); _client = null; }
}
