#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Mint a Robinhood MCP OAuth bearer token WITHOUT the MCP inspector.
//
// Why this exists: the inspector runs the OAuth token exchange from the
// browser, and Robinhood's token host (api.robinhood.com) sends no CORS
// headers, so that POST is permanently blocked ("Failed to fetch"). Doing the
// exact same PKCE flow from Node sidesteps CORS entirely.
//
// Run:  node scripts/get-robinhood-token.mjs
// It will: discover OAuth metadata → dynamically register a client → print an
// authorize URL for you to open → catch the redirect on localhost → exchange
// the code for tokens → print the access token (and refresh token).
// ---------------------------------------------------------------------------
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { URL } from 'node:url';

const MCP_URL = process.env.ROBINHOOD_MCP_URL || 'https://agent.robinhood.com/mcp/trading';
const CALLBACK_PORT = Number(process.env.OAUTH_CALLBACK_PORT || 8989);
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${url} → ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { throw new Error(`non-JSON from ${url}: ${text.slice(0, 200)}`); }
}

// 1) Discover OAuth metadata (path-aware, per RFC 9728) ----------------------
async function discover() {
  const u = new URL(MCP_URL);
  const prBase = `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
  const pr = await getJson(prBase).catch(() => getJson(`${u.origin}/.well-known/oauth-protected-resource`));
  const issuer = (pr.authorization_servers && pr.authorization_servers[0]) || u.origin;
  const iu = new URL(issuer);
  const asUrl = `${iu.origin}/.well-known/oauth-authorization-server${iu.pathname === '/' ? '' : iu.pathname}`;
  const as = await getJson(asUrl).catch(() => getJson(`${iu.origin}/.well-known/oauth-authorization-server`));
  const scope = (pr.scopes_supported || as.scopes_supported || ['internal']).join(' ');
  return { as, scope, resource: pr.resource || MCP_URL };
}

// 2) Dynamic client registration (RFC 7591) ---------------------------------
async function register(as, scope) {
  if (!as.registration_endpoint) throw new Error('server does not advertise a registration_endpoint');
  const reg = await getJson(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'stock-studio-local',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    }),
  });
  if (!reg.client_id) throw new Error(`registration returned no client_id: ${JSON.stringify(reg).slice(0, 300)}`);
  return reg.client_id;
}

// 3) Wait for the browser redirect on localhost -----------------------------
function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body style="font-family:sans-serif;background:#0E1316;color:#E9E7DF;padding:40px">
        <h2>${err ? 'Authorization failed' : 'Authorized ✓'}</h2>
        <p>${err ? err : 'You can close this tab and return to the terminal.'}</p></body></html>`);
      server.close();
      if (err) return reject(new Error(`authorize error: ${err}`));
      if (!code) return reject(new Error('no code in redirect'));
      if (state !== expectedState) return reject(new Error('state mismatch (possible CSRF) — aborting'));
      resolve(code);
    });
    server.listen(CALLBACK_PORT, () => {});
    server.on('error', reject);
  });
}

// 4) Exchange the code for tokens (server-side → no CORS) --------------------
async function exchange(as, clientId, code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  return getJson(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

(async () => {
  console.log(`\n[1/4] discovering OAuth metadata for ${MCP_URL} …`);
  const { as, scope } = await discover();
  console.log(`      authorize: ${as.authorization_endpoint}`);
  console.log(`      token:     ${as.token_endpoint}`);

  console.log(`[2/4] registering a local client …`);
  const clientId = await register(as, scope);
  console.log(`      client_id: ${clientId}`);

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const authUrl = new URL(as.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope,
    state,
  }).toString();

  console.log(`\n[3/4] Open this URL in your browser, log in, and approve:\n`);
  console.log(`  ${authUrl.toString()}\n`);
  console.log(`      waiting for the redirect on ${REDIRECT_URI} …`);
  const code = await waitForCode(state);

  console.log(`[4/4] exchanging code for tokens …`);
  const tok = await exchange(as, clientId, code, verifier);

  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`ACCESS TOKEN (paste into the dashboard → Credentials → Robinhood MCP token):\n`);
  console.log(tok.access_token || '(no access_token in response!)');
  if (tok.refresh_token) console.log(`\nrefresh_token: ${tok.refresh_token}`);
  if (tok.expires_in) console.log(`expires_in: ${tok.expires_in}s`);
  console.log(`──────────────────────────────────────────────────────────────\n`);
  process.exit(0);
})().catch((e) => {
  console.error(`\n✗ ${e.message}\n`);
  process.exit(1);
});
