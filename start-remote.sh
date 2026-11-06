#!/bin/zsh
set -euo pipefail

phonebase_dir="${0:A:h}"
cd "$phonebase_dir"

if curl --max-time 1 -sS http://127.0.0.1:3016/status >/dev/null 2>&1; then
  echo "Phonebase Supervisor already owns the gateway and tunnel."
  echo "Use: npm run stable:status"
  exit 0
fi

: "${PHONEBASE_REMOTE_TOKEN:?Set PHONEBASE_REMOTE_TOKEN to a random value of at least 32 characters}"
: "${PHONEBASE_REMOTE_ALLOWED_ORIGINS:?Set PHONEBASE_REMOTE_ALLOWED_ORIGINS to the deployed console origin}"

export PHONEBASE_REMOTE_HOST="${PHONEBASE_REMOTE_HOST:-127.0.0.1}"
export PHONEBASE_REMOTE_PORT="${PHONEBASE_REMOTE_PORT:-3015}"
export PHONEBASE_REMOTE_UPSTREAM="${PHONEBASE_REMOTE_UPSTREAM:-http://127.0.0.1:3013}"

gateway_pid=""
cleanup() {
  if [[ -n "$gateway_pid" ]]; then
    kill "$gateway_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

npm run remote:gateway &
gateway_pid=$!

probe_origin="${PHONEBASE_REMOTE_ALLOWED_ORIGINS%%,*}"
for _ in {1..30}; do
  if curl --max-time 1 -fsS \
    -H "Origin: $probe_origin" \
    -H "Authorization: Bearer $PHONEBASE_REMOTE_TOKEN" \
    "http://127.0.0.1:$PHONEBASE_REMOTE_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

curl --max-time 2 -fsS \
  -H "Origin: $probe_origin" \
  -H "Authorization: Bearer $PHONEBASE_REMOTE_TOKEN" \
  "http://127.0.0.1:$PHONEBASE_REMOTE_PORT/health" >/dev/null

ngrok http "http://127.0.0.1:$PHONEBASE_REMOTE_PORT" \
  --log stdout \
  --log-format logfmt
