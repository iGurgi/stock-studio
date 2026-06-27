#!/usr/bin/env node
// Discover the Robinhood MCP tool list (names + input schemas) so the
// deterministic client can call tools with correct arguments.
//
// Token resolution order: ROBINHOOD_MCP_TOKEN env → DB kv (secret:robinhood_mcp_token).
// Prints schemas only — never the token.
//
// Run:  node scripts/mcp-discover.mjs            (reads token from ./data/studio.db or DB_PATH)
//       ROBINHOOD_MCP_TOKEN=... node scripts/mcp-discover.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = process.env.ROBINHOOD_MCP_URL || 'https://agent.robinhood.com/mcp/trading';

async function getToken() {
  if (process.env.ROBINHOOD_MCP_TOKEN) return process.env.ROBINHOOD_MCP_TOKEN;
  const { DatabaseSync } = await import('node:sqlite');
  const path = process.env.DB_PATH || new URL('../data/studio.db', import.meta.url).pathname.replace(/^\//, '');
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT value FROM kv WHERE key='secret:robinhood_mcp_token'").get();
  return row?.value || '';
}

const token = await getToken();
if (!token) { console.error('no token (set ROBINHOOD_MCP_TOKEN or save it in the DB first)'); process.exit(1); }

const transport = new StreamableHTTPClientTransport(new URL(URL_), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'stock-studio-discover', version: '0.1.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`connected. ${tools.length} tools:\n`);
  for (const t of tools) {
    const props = t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : [];
    const req = t.inputSchema?.required || [];
    console.log(`• ${t.name}(${props.map(p => req.includes(p) ? p + '*' : p).join(', ')})`);
    if (t.description) console.log(`    ${t.description.split('\n')[0].slice(0, 110)}`);
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  if (String(e.message).match(/401|403|unauth/i)) console.error('  → token likely expired; re-mint with scripts/get-robinhood-token.mjs');
  process.exit(1);
} finally {
  await client.close().catch(() => {});
}
