#!/bin/zsh
set -euo pipefail

PHONEBASE_PROJECT_DIR="${0:A:h:h}"
PHONEBASE_KEYCHAIN_SERVICE="ai.phonebase.remote"
PHONEBASE_TUNNEL_STATE_PATH="${PHONEBASE_REMOTE_TUNNEL_STATE_PATH:-$PHONEBASE_PROJECT_DIR/.runtime/remote-tunnel.json}"
PHONEBASE_ALLOWED_ORIGIN="${PHONEBASE_REMOTE_ALLOWED_ORIGINS:-https://phonebase.co,https://phonebase-cloud-beta.alhazaranwar205.chatgpt.site}"
PHONEBASE_CONSOLE_URL="${PHONEBASE_CLOUD_CONSOLE_URL:-https://phonebase.co/console}"
PHONEBASE_TUNNEL_PROTOCOL="${PHONEBASE_REMOTE_TUNNEL_PROTOCOL:-quic}"
PHONEBASE_USERNAME="$(id -un)"

cd "$PHONEBASE_PROJECT_DIR"

PHONEBASE_SESSION_TOKEN="$(
  security find-generic-password \
    -a "$PHONEBASE_USERNAME" \
    -s "$PHONEBASE_KEYCHAIN_SERVICE" \
    -w 2>/dev/null || true
)"
if [[ -z "$PHONEBASE_SESSION_TOKEN" ]]; then
  PHONEBASE_SESSION_TOKEN="$(openssl rand -hex 32)"
  security add-generic-password \
    -U \
    -a "$PHONEBASE_USERNAME" \
    -s "$PHONEBASE_KEYCHAIN_SERVICE" \
    -w "$PHONEBASE_SESSION_TOKEN" >/dev/null
fi

mkdir -p "${PHONEBASE_TUNNEL_STATE_PATH:h}" build/runtime

PHONEBASE_NAMED_CONFIG_PATH="${PHONEBASE_REMOTE_NAMED_CONFIG_PATH:-$PHONEBASE_PROJECT_DIR/.runtime/named-remote.json}"
PHONEBASE_SESSION_DIR=""
PHONEBASE_CREDENTIALS_PATH=""
if [[ -f "$PHONEBASE_NAMED_CONFIG_PATH" ]]; then
  # A configured fixed gateway must fail closed, never silently rotate to a
  # temporary hostname and invalidate every customer link.
  jq -e '.version == 1 and (.gatewayUrl | test("^https://[a-zA-Z0-9.-]+$")) and (.tokenFile | type == "string")' \
    "$PHONEBASE_NAMED_CONFIG_PATH" >/dev/null
  PHONEBASE_PUBLIC_URL="$(jq -er '.gatewayUrl' "$PHONEBASE_NAMED_CONFIG_PATH")"
  PHONEBASE_NAMED_TOKEN_PATH="$(jq -er '.tokenFile' "$PHONEBASE_NAMED_CONFIG_PATH")"
  [[ -s "$PHONEBASE_NAMED_TOKEN_PATH" ]] || { echo "Named tunnel token file is missing" >&2; exit 1; }
  PHONEBASE_TUNNEL_ARGS=(run --token-file "$PHONEBASE_NAMED_TOKEN_PATH")
else
  if [[ -f "$PHONEBASE_TUNNEL_STATE_PATH" ]] && jq -e '
    .version == 1 and
    ((.tunnelId | type) == "string" and (.tunnelId | length) > 0) and
    ((.hostname | type) == "string" and (.hostname | test("^[a-z0-9-]+\\.trycloudflare\\.com$"))) and
    ((.accountTag | type) == "string" and (.accountTag | length) > 0) and
    ((.tunnelSecret | type) == "string" and (.tunnelSecret | length) > 16)
  ' "$PHONEBASE_TUNNEL_STATE_PATH" >/dev/null 2>&1; then
    PHONEBASE_TUNNEL_ID="$(jq -er '.tunnelId' "$PHONEBASE_TUNNEL_STATE_PATH")"
    PHONEBASE_TUNNEL_HOSTNAME="$(jq -er '.hostname' "$PHONEBASE_TUNNEL_STATE_PATH")"
    PHONEBASE_TUNNEL_ACCOUNT="$(jq -er '.accountTag' "$PHONEBASE_TUNNEL_STATE_PATH")"
    PHONEBASE_TUNNEL_SECRET="$(jq -er '.tunnelSecret' "$PHONEBASE_TUNNEL_STATE_PATH")"
  else
    PHONEBASE_TUNNEL_RESPONSE="$(
      curl -4 -fsS -X POST https://api.trycloudflare.com/tunnel
    )"
    PHONEBASE_TUNNEL_ID="$(jq -er '.result.id' <<<"$PHONEBASE_TUNNEL_RESPONSE")"
    PHONEBASE_TUNNEL_HOSTNAME="$(jq -er '.result.hostname' <<<"$PHONEBASE_TUNNEL_RESPONSE")"
    PHONEBASE_TUNNEL_ACCOUNT="$(jq -er '.result.account_tag' <<<"$PHONEBASE_TUNNEL_RESPONSE")"
    PHONEBASE_TUNNEL_SECRET="$(jq -er '.result.secret' <<<"$PHONEBASE_TUNNEL_RESPONSE")"
    PHONEBASE_TUNNEL_STATE_TEMP="$(mktemp "${PHONEBASE_TUNNEL_STATE_PATH}.XXXXXX")"
    jq -n \
      --arg tunnelId "$PHONEBASE_TUNNEL_ID" \
      --arg hostname "$PHONEBASE_TUNNEL_HOSTNAME" \
      --arg accountTag "$PHONEBASE_TUNNEL_ACCOUNT" \
      --arg tunnelSecret "$PHONEBASE_TUNNEL_SECRET" \
      '{version:1,tunnelId:$tunnelId,hostname:$hostname,accountTag:$accountTag,tunnelSecret:$tunnelSecret}' \
      >"$PHONEBASE_TUNNEL_STATE_TEMP"
    chmod 600 "$PHONEBASE_TUNNEL_STATE_TEMP"
    mv "$PHONEBASE_TUNNEL_STATE_TEMP" "$PHONEBASE_TUNNEL_STATE_PATH"
  fi
  PHONEBASE_PUBLIC_URL="https://${PHONEBASE_TUNNEL_HOSTNAME}"

  PHONEBASE_SESSION_DIR="$(mktemp -d /tmp/phonebase-remote.XXXXXX)"
  PHONEBASE_CREDENTIALS_PATH="$PHONEBASE_SESSION_DIR/credentials.json"
  jq -n \
    --arg account "$PHONEBASE_TUNNEL_ACCOUNT" \
    --arg secret "$PHONEBASE_TUNNEL_SECRET" \
    --arg id "$PHONEBASE_TUNNEL_ID" \
    '{AccountTag:$account,TunnelSecret:$secret,TunnelID:$id}' \
    >"$PHONEBASE_CREDENTIALS_PATH"
  chmod 600 "$PHONEBASE_CREDENTIALS_PATH"
  PHONEBASE_TUNNEL_ARGS=(run --url http://127.0.0.1:3015 --credentials-file "$PHONEBASE_CREDENTIALS_PATH" "$PHONEBASE_TUNNEL_ID")
fi

launchctl setenv PHONEBASE_REMOTE_TOKEN "$PHONEBASE_SESSION_TOKEN"
launchctl setenv PHONEBASE_LEASE_SIGNING_SECRET "$PHONEBASE_SESSION_TOKEN"
launchctl setenv PHONEBASE_REMOTE_PUBLIC_URL "$PHONEBASE_PUBLIC_URL"
launchctl setenv PHONEBASE_REMOTE_ALLOWED_ORIGINS "$PHONEBASE_ALLOWED_ORIGIN"
launchctl setenv PHONEBASE_CLOUD_CONSOLE_URL "$PHONEBASE_CONSOLE_URL"
launchctl setenv PHONEBASE_RENTAL_LEASES_PATH "$PHONEBASE_PROJECT_DIR/.runtime/rental-leases.json"

cloudflared tunnel \
  --edge-ip-version 4 \
  --protocol "$PHONEBASE_TUNNEL_PROTOCOL" \
  --no-autoupdate \
  "${PHONEBASE_TUNNEL_ARGS[@]}" \
  >build/runtime/remote-tunnel.log 2>&1 &
PHONEBASE_TUNNEL_PID=$!

cleanup() {
  kill "$PHONEBASE_TUNNEL_PID" 2>/dev/null || true
  [[ -z "${PHONEBASE_GATEWAY_PID:-}" ]] || kill "$PHONEBASE_GATEWAY_PID" 2>/dev/null || true
  [[ -z "$PHONEBASE_CREDENTIALS_PATH" ]] || rm -f "$PHONEBASE_CREDENTIALS_PATH"
  [[ -z "$PHONEBASE_SESSION_DIR" ]] || rmdir "$PHONEBASE_SESSION_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

launchctl kickstart -k "gui/$(id -u)/com.phonebase.control-plane"
launchctl unsetenv PHONEBASE_REMOTE_TOKEN
launchctl unsetenv PHONEBASE_LEASE_SIGNING_SECRET

export PHONEBASE_REMOTE_TOKEN="$PHONEBASE_SESSION_TOKEN"
export PHONEBASE_LEASE_SIGNING_SECRET="$PHONEBASE_SESSION_TOKEN"
export PHONEBASE_REMOTE_PUBLIC_URL="$PHONEBASE_PUBLIC_URL"
export PHONEBASE_REMOTE_ALLOWED_ORIGINS="$PHONEBASE_ALLOWED_ORIGIN"
export PHONEBASE_CLOUD_CONSOLE_URL="$PHONEBASE_CONSOLE_URL"
export PHONEBASE_RENTAL_LEASES_PATH="$PHONEBASE_PROJECT_DIR/.runtime/rental-leases.json"

echo "Phonebase public gateway: $PHONEBASE_PUBLIC_URL"
# Keep the parent alive so either child exiting restarts the complete session
# under launchd; exec used to discard the EXIT trap and orphan cloudflared.
node --import tsx bridge/remote_gateway.ts &
PHONEBASE_GATEWAY_PID=$!
while kill -0 "$PHONEBASE_TUNNEL_PID" 2>/dev/null && kill -0 "$PHONEBASE_GATEWAY_PID" 2>/dev/null; do
  sleep 2
done
exit 1
