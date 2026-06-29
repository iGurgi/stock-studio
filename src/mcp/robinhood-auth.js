import { getSecret, setSecret } from '../config.js';
import { logEvent } from '../db.js';

// Automatic OAuth token refresh for the Robinhood MCP.
//
// scripts/get-robinhood-token.mjs registers a public PKCE client and saves the
// refresh token, that client_id, and the token endpoint. When the access token
// expires, the MCP client (mcp/robinhood-client.js) calls refreshAccessToken()
// to mint a new one with the refresh_token grant — no human round-trip.

let _refreshing = null;

async function doRefresh() {
  const refreshToken = getSecret('robinhoodRefreshToken');
  const clientId = getSecret('robinhoodOauthClientId');
  const tokenEndpoint = getSecret('robinhoodTokenEndpoint');
  // Without the saved refresh material we can't auto-refresh — fall back to a
  // manual re-mint (the caller surfaces that).
  if (!refreshToken || !clientId || !tokenEndpoint) return null;

  let res;
  try {
    res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
  } catch (e) {
    logEvent('error', 'auth', `Robinhood token refresh request failed: ${e.message || e}`);
    return null;
  }

  const text = await res.text();
  if (!res.ok) {
    // A rejected refresh token won't fix itself — tell the operator to re-mint.
    logEvent('alert', 'auth', `Robinhood token refresh rejected (${res.status}) — re-mint with scripts/get-robinhood-token.mjs`);
    return null;
  }

  let tok;
  try { tok = JSON.parse(text); } catch { return null; }
  if (!tok.access_token) return null;

  setSecret('robinhoodMcpToken', tok.access_token);
  // Refresh tokens often rotate on use; persist the new one or the next refresh fails.
  if (tok.refresh_token) setSecret('robinhoodRefreshToken', tok.refresh_token);
  logEvent('info', 'auth', 'Robinhood MCP access token refreshed');
  return tok.access_token;
}

// Refresh the access token, coalescing concurrent callers so a burst of expired
// requests triggers a single token exchange. Returns the new token, or null if
// refresh isn't configured or failed (caller should surface a re-mint hint).
export function refreshAccessToken() {
  if (!_refreshing) _refreshing = doRefresh().finally(() => { _refreshing = null; });
  return _refreshing;
}
