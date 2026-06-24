#!/usr/bin/env bash
# Local pre-push gate: build the image, bring the stack up, verify it serves and
# gates auth, confirm the agent container booted, then tear down.
#
#   ./scripts/smoke.sh            infra check only (no live API calls, no cost)
#   ./scripts/smoke.sh --live     also trigger ONE research pass (uses real API/Robinhood creds)
#   ./scripts/smoke.sh --keep     leave the stack running afterward
#
# --live never places orders: it only runs the read-only research pass, and the
# stack still respects PLACEMENT_ENABLED from your .env.
set -euo pipefail

LIVE=false; KEEP=false
for a in "$@"; do
  case "$a" in
    --live) LIVE=true ;;
    --keep) KEEP=true ;;
    *) echo "unknown arg: $a"; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BASE="http://127.0.0.1:8787"
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

[ -f .env ] || { echo "missing .env — copy .env.example and fill it in first"; exit 1; }
TOKEN="$(grep -E '^CONTROL_TOKEN=' .env | cut -d= -f2-)"

cleanup() { if ! $KEEP; then echo "--- tearing down ---"; docker compose down >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT

echo "--- build ---";    docker compose build
echo "--- up ---";       docker compose up -d

echo "--- waiting for dashboard health ---"
up=false
for i in $(seq 1 30); do
  if [ "$(code "$BASE/api/state")" = "200" ]; then up=true; break; fi
  sleep 2
done
$up && ok "dashboard answered /api/state" || { bad "dashboard never became healthy"; docker compose logs --tail=40 dashboard; exit 1; }

echo "--- checks ---"
[ "$(code "$BASE/")" = "200" ] && ok "GET / serves the console" || bad "GET / did not return 200"

# auth gate: approving without a token must be rejected
[ "$(code -X POST "$BASE/api/proposals/1/approve")" = "401" ] && ok "approve without token -> 401" || bad "approve was NOT gated"

# halt toggle round-trips with the token
if [ -n "$TOKEN" ]; then
  h=$(curl -s -X POST "$BASE/api/halt" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"halted":true}')
  echo "$h" | grep -q '"halted":true' && ok "halt toggle works with token" || bad "halt toggle failed: $h"
  curl -s -X POST "$BASE/api/halt" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"halted":false}' >/dev/null
else
  bad "CONTROL_TOKEN not set in .env — cannot test write actions"
fi

# agent container is running
docker compose ps agent --format '{{.State}}' | grep -qi running && ok "agent container is running" || bad "agent container not running"

if $LIVE; then
  echo "--- live: triggering one research pass (read-only) ---"
  [ -z "$TOKEN" ] && bad "no token; skipping --live" || {
    curl -s -X POST "$BASE/api/agent/run" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"kind":"research"}' >/dev/null
    done_live=false
    for i in $(seq 1 45); do
      last=$(curl -s "$BASE/api/runs" | head -c 4000)
      echo "$last" | grep -q '"kind":"research"' && echo "$last" | grep -q '"status":"ok"' && { done_live=true; break; }
      echo "$last" | grep -q '"status":"error"' && { bad "research pass errored — check creds in .env"; break; }
      sleep 2
    done
    $done_live && ok "live research pass completed" || true
  }
fi

echo "--- result: $PASS passed, $FAIL failed ---"
[ "$FAIL" -eq 0 ]
