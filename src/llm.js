import { config } from './config.js';

// OpenAI-compatible chat client. Works with Ollama (/v1), LM Studio, vLLM, etc.
// Replaces the Anthropic Messages API as the reasoning backend. Tooling/MCP is
// handled deterministically elsewhere (see mcp/robinhood-client.js), so this is
// a plain text/JSON completion client — no function-calling required.

/**
 * @param {object} opts
 * @param {string} [opts.model]        defaults to config.llm.models.research
 * @param {string} [opts.system]
 * @param {Array}  opts.messages       OpenAI-style [{role,content}]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {boolean}[opts.json]         request a JSON object response
 * @returns {Promise<{text:string, raw:object}>}
 */
// Serialize all LLM calls process-wide. The reasoning backend is a single,
// slow ollama box; letting research/proposal/tracking/discovery hit it
// concurrently makes every request queue on the GPU and blow its timeout
// (surfacing as an opaque "fetch failed"). One in flight at a time is both
// faster end-to-end and far more reliable for this low-frequency desk.
let _chain = Promise.resolve();
export function chat(opts) {
  const result = _chain.then(() => chatOnce(opts), () => chatOnce(opts));
  _chain = result.catch(() => {}); // a failed call must not break the queue
  return result;
}

async function chatOnce({
  model = config.llm.models.research,
  system,
  messages,
  maxTokens = 4096,
  temperature = 0.2,
  json = false,
}) {
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const body = {
    model,
    messages: msgs,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  const headers = { 'content-type': 'application/json' };
  if (config.llm.apiKey) headers.authorization = `Bearer ${config.llm.apiKey}`;

  let lastErr;
  for (let attempt = 0; attempt <= config.llm.retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
    try {
      const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM ${res.status} (${config.llm.baseUrl}): ${text.slice(0, 800)}`);
      }
      const data = await res.json();
      const text = (data.choices?.[0]?.message?.content || '').trim();
      return { text, raw: data };
    } catch (e) {
      // Surface the underlying network cause instead of a bare "fetch failed".
      const cause = e.name === 'AbortError'
        ? `timeout after ${config.llm.timeoutMs}ms`
        : (e.cause?.code || e.cause?.message || e.message);
      lastErr = new Error(`LLM call failed (${model} @ ${config.llm.baseUrl}): ${cause}`);
      if (attempt < config.llm.retries) await new Promise((r) => setTimeout(r, 1500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Concatenated assistant text (parity with the old anthropic.allText). */
export function allText(resp) {
  return resp?.text ?? '';
}

/**
 * Pull a JSON object/array out of a model response that was asked for JSON.
 * Tolerates ```json fences, leading prose, and <think>…</think> blocks that
 * reasoning models (e.g. qwen3) emit.
 */
export function extractJson(resp) {
  let text = (typeof resp === 'string' ? resp : resp?.text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json|```/g, '')
    .trim();
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
