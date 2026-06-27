import crypto from 'node:crypto';
import { config } from '../config.js';

// Signed REST client for the Coinbase Advanced Trade API.
// Auth: a CDP API key (Ed25519 or ECDSA) → a short-lived JWT per request,
// passed as `Authorization: Bearer <jwt>`. No browser/OAuth flow — headless.
// Mirrors the official SDK's JWT construction.

const HOST = 'api.coinbase.com';

const b64url = (input) => Buffer.from(input).toString('base64url');

// Load the CDP private key (PEM for EC/Ed25519, or base64-encoded Ed25519 seed)
// and report which JOSE alg to use.
function loadKey(secret) {
  const s = String(secret || '').trim().replace(/\\n/g, '\n'); // tolerate escaped newlines
  if (s.includes('BEGIN')) {
    const key = crypto.createPrivateKey(s);
    const alg = key.asymmetricKeyType === 'ed25519' ? 'EdDSA' : 'ES256';
    return { key, alg };
  }
  // base64 Ed25519: 64 bytes (seed+pub) or 32 bytes (seed). Use the 32-byte seed.
  const raw = Buffer.from(s, 'base64');
  const seed = raw.length >= 32 ? raw.subarray(0, 32) : raw;
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), // Ed25519 PKCS8 prefix
    seed,
  ]);
  const key = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return { key, alg: 'EdDSA' };
}

// Build a CDP JWT for one request. `uri` omits scheme and query string:
//   "GET api.coinbase.com/api/v3/brokerage/accounts"
function makeJwt(method, path) {
  const keyName = config.coinbase.apiKeyName;
  const { key, alg } = loadKey(config.coinbase.apiSecret);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg, kid: keyName, typ: 'JWT', nonce: crypto.randomBytes(16).toString('hex') };
  const payload = {
    sub: keyName,
    iss: 'cdp',
    nbf: now,
    exp: now + 120,
    uri: `${method} ${HOST}${path}`,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  let sig;
  if (alg === 'EdDSA') {
    sig = crypto.sign(null, Buffer.from(signingInput), key);
  } else {
    // ES256 needs the raw R||S (JOSE) signature, not DER.
    sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  }
  return `${signingInput}.${b64url(sig)}`;
}

/**
 * Make a signed Advanced Trade request.
 * @param {string} method  GET|POST|...
 * @param {string} path    e.g. "/api/v3/brokerage/accounts" (no query)
 * @param {object} [opts]  { query, body }
 * @returns {Promise<any>} parsed JSON
 */
export async function cbRequest(method, path, { query, body } = {}) {
  if (!config.coinbase.apiKeyName || !config.coinbase.apiSecret) {
    throw new Error('Coinbase CDP API key/secret not set (save them in the dashboard Credentials panel)');
  }
  const jwt = makeJwt(method, path); // uri claim uses the bare path, no query
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`https://${HOST}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Coinbase ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}
