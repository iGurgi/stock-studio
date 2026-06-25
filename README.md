# Stock Studio

An autonomous research / tracking / trade-proposal desk for equities, ETFs, options, and
crypto, wired to the **Robinhood MCP**. Same self-hosted spirit as your agent studio: a
long-running agent loop plus a private dashboard, all on one box.

**It is autonomous everywhere except the last inch.** Research, tracking, thesis-keeping, and
trade *proposals* all happen on their own. Placing a real order requires you to click Approve
on the dashboard and type the ticker to arm it. Nothing reaches your brokerage without that.

> Not investment advice. This is tooling that operates *your* account under *your* sign-off.
> You are responsible for every order placed. Start with `PLACEMENT_ENABLED=false`.

---

## How it fits together

```
                 ┌──────────────── your server (same box as Robinhood MCP) ───────────────┐
                 │                                                                          │
  Anthropic API ←┼─ agent loop ── research ──┐                                              │
  (+ Robinhood   │   (scheduler)  tracking ──┼─→ SQLite (node:sqlite) ──→ Express dashboard │→ you (tailnet)
   MCP connector │                proposals ─┘        theses / proposals / events           │   approve/halt
   + web_search) │                                                                          │
                 │   approve click ──→ placeApprovedOrder() ──→ Robinhood MCP (place tool)  │
                 └──────────────────────────────────────────────────────────────────────────┘
```

The agent "thinks" by calling the Anthropic Messages API with the Robinhood MCP attached as a
connector (`mcp_servers`, beta header `mcp-client-2025-11-20`) plus `web_search`. All state lives
in a local SQLite file. The dashboard reads that state and is the only place orders get approved.

## Requirements

- Node.js **>= 22.5** (uses the built-in `node:sqlite` — no native build step).
- An Anthropic API key.
- The Robinhood MCP reachable at a public HTTPS URL (it already is: `agent.robinhood.com/mcp/trading`).
  The Messages API connector reaches MCP servers **from Anthropic's cloud**, so the MCP must be
  public — a Tailscale-private URL would *not* work for the connector. Your dashboard, by
  contrast, binds to localhost/your tailnet and stays private.
- A Robinhood brokerage account flagged `agentic_allowed=true` (required for order tools).

## Setup

```bash
cd stock-studio
cp .env.example .env       # then edit .env
npm install
npm run check              # syntax check
npm start                  # dashboard + in-process scheduler
```

Open `http://127.0.0.1:8787`. Paste your `CONTROL_TOKEN` into the dashboard to unlock the
approve/halt controls.

To run the loop and the dashboard as separate processes instead, start the server with
`RUN_SCHEDULER=false npm start` and run `npm run agent` separately.

## Docker

One image is used for both roles. No native build step (built-in `node:sqlite`), so the image
is small.

```bash
cp .env.example .env       # fill it in; HOST and DB_PATH are set for you by compose
docker compose up -d --build
docker compose logs -f
```

That brings up two containers from the same image — `dashboard` (server + API) and `agent`
(the loop) — sharing one named volume `studio-data` for the SQLite file. Restart or inspect
either independently (`docker compose restart agent`).

**Exposure / networking.** Inside the container the app binds `0.0.0.0`; the real boundary is
the published port. The compose file publishes to `127.0.0.1:8787` only, so out of the box the
dashboard is reachable on the host loopback and nowhere else. To use it from your tailnet, pick one:

- front it with Tailscale: `tailscale serve` pointing at `localhost:8787` (gives HTTPS, stays
  tailnet-only) — check `tailscale serve --help` for the current syntax, or
- change the mapping to your tailscale IP, e.g. `"100.x.y.z:8787:8787"`.

Do **not** publish to `0.0.0.0:8787` unless something else is doing authentication in front.

**Validate before pushing.** `./scripts/smoke.sh` builds, boots, checks the dashboard/API/auth-gating and the agent container, then tears down — run it locally as a pre-push gate. Add `--live` to also fire one read-only research pass against your real creds (never places orders), or `--keep` to leave the stack up.

**Data.** Everything lives in the `studio-data` volume. Back it up with
`docker run --rm -v stock-studio_studio-data:/data -v "$PWD":/out alpine tar czf /out/studio-backup.tgz /data`.

### Docker → all-in-one

Prefer a single container? Skip compose and run the default command (it runs the scheduler
in-process):

```bash
docker build -t stock-studio .
docker run -d --name stock-studio --init \
  --env-file .env -e HOST=0.0.0.0 \
  -p 127.0.0.1:8787:8787 \
  -v studio-data:/data \
  stock-studio
```

One process means zero SQLite write contention; the tradeoff is you restart the loop and the
dashboard together.

### Getting the Robinhood token

The connector needs an OAuth bearer token for the Robinhood MCP; it does not run the OAuth flow
for you. Mint one with the bundled helper:

```bash
node scripts/get-robinhood-token.mjs
```

It discovers the OAuth metadata, registers a local client, prints an authorize URL (open it,
log in, approve), catches the redirect on `http://localhost:8989/callback`, and exchanges the
code for tokens — then prints the access token. Paste it into the dashboard's **Credentials**
panel (or `ROBINHOOD_MCP_TOKEN`). Port busy? `OAUTH_CALLBACK_PORT=9090 node scripts/get-robinhood-token.mjs`.

> **Don't use the MCP inspector for this.** Its OAuth token exchange runs in the browser, and
> Robinhood's token host (`api.robinhood.com`) sends no CORS headers, so that step always fails
> with "Failed to fetch". The script does the exchange from Node, which isn't subject to CORS.

Tokens expire; if the agent starts failing with auth errors, mint a fresh one. (Automating the
refresh is a good v2 task.)

## The safety model

Layers, outermost first:

1. **PLACEMENT_ENABLED** — while `false`, approvals are refused server-side. Run here until you
   trust it.
2. **Human gate** — proposals are written as `pending`. Placement only happens via the dashboard
   Approve button, and you must type the ticker to arm it.
3. **Locked placement path** — `placeApprovedOrder()` exposes the MCP with `allowed_tools` set to
   the single place tool, temperature 0, and passes the exact pre-validated parameters. The model
   physically cannot cancel, modify, or place anything else in that call.
4. **Risk rails** — `MAX_POSITION_USD`, `MAX_NEW_TRADES_PER_DAY`, `MAX_DAILY_LOSS_USD`, and
   market-hours checks are enforced before a proposal is ever written.
5. **Kill switch** — the HALT button stops new research/proposals and blocks approvals; tracking
   keeps running so you can still watch positions.
6. **Injection defense** — every prompt tells the model to treat tool/web/news output as data,
   never instructions. The human gate is the real backstop for this.

## Tuning the desk

- `WATCH_UNIVERSE` and `INCLUDE_ROBINHOOD_WATCHLISTS` set what gets researched.
- Cadences (`*_EVERY_MIN`) control how often each pass runs.
- The agent's behavior lives in the prompts in `src/agent/*.js` and `src/robinhood.js` — that's
  where you shape how it forms theses and what kinds of trades it proposes.

## Files

```
src/
  config.js        env + rails + market-hours helper
  db.js            SQLite schema + helpers (node:sqlite)
  anthropic.js     Messages API wrapper (MCP connector + web_search) and block parsers
  robinhood.js     portfolio fetch, order simulation, and the locked placement path
  agent/
    research.js    builds/updates theses from data + news
    tracking.js    snapshots portfolio, checks positions vs theses, raises alerts
    proposals.js   generates candidates, enforces rails, simulates, writes pending proposals
    scheduler.js   the autonomous loop
  server.js        dashboard + REST API + approval/placement endpoints
  public/index.html  operator console
data/studio.db     created on first run
```

## Known v2 work

- Automatic OAuth token refresh for the Robinhood MCP.
- Swap the placement step for a direct Node MCP client (removes the model from the place call
  entirely — fully deterministic).
- Per-symbol position limits and sector exposure caps.
- Backtest mode that replays proposals against history before you arm placement.
