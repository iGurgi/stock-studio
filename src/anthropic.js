import { config } from './config.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MCP_BETA = 'mcp-client-2025-11-20';

/**
 * Call the Anthropic Messages API.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.system
 * @param {Array}  opts.messages         - full message array
 * @param {boolean}[opts.useRobinhood]   - attach the Robinhood MCP connector
 * @param {string[]}[opts.allowedTools]  - restrict which Robinhood tools are exposed
 * @param {boolean}[opts.useWebSearch]   - attach the web_search tool
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @returns {Promise<object>} the raw API response
 */
export async function callClaude({
  model,
  system,
  messages,
  useRobinhood = false,
  allowedTools = null,
  useWebSearch = false,
  maxTokens = 4096,
  temperature = 0.2,
}) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': config.anthropic.apiKey,
    'anthropic-version': '2023-06-01',
  };

  const body = { model, max_tokens: maxTokens, temperature, messages };
  if (system) body.system = system;

  const tools = [];
  if (useWebSearch) tools.push({ type: 'web_search_20250305', name: 'web_search' });
  if (tools.length) body.tools = tools;

  if (useRobinhood) {
    headers['anthropic-beta'] = MCP_BETA;
    const server = {
      type: 'url',
      url: config.robinhood.mcpUrl,
      name: 'robinhood',
    };
    if (config.robinhood.mcpToken) server.authorization_token = config.robinhood.mcpToken;
    if (allowedTools && allowedTools.length) {
      server.tool_configuration = { enabled: true, allowed_tools: allowedTools };
    }
    body.mcp_servers = [server];
  }

  const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 800)}`);
  }
  return res.json();
}

/** Concatenate all assistant text blocks. */
export function allText(resp) {
  return (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Every Robinhood tool result, parsed where possible. */
export function toolResults(resp) {
  return (resp.content || [])
    .filter((b) => b.type === 'mcp_tool_result')
    .map((b) => {
      const text = b.content?.map((c) => c.text || '').join('') || '';
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* leave as text */ }
      return { is_error: !!b.is_error, text, parsed, tool_use_id: b.tool_use_id };
    });
}

/** Which Robinhood tools got called, with their inputs. */
export function toolCalls(resp) {
  return (resp.content || [])
    .filter((b) => b.type === 'mcp_tool_use')
    .map((b) => ({ name: b.name, input: b.input, id: b.id }));
}

/**
 * Pull a JSON object/array out of an assistant response that was instructed to
 * return JSON only. Tolerates ```json fences and leading prose.
 */
export function extractJson(resp) {
  let text = allText(resp).replace(/```json|```/g, '').trim();
  // find first { or [ and matching last } or ]
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  if (end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
