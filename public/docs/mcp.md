# Connect an MCP agent

Give your agent physical device tools through a local stdio bridge to your remote station.

## Understand the transport

The agent host launches the PhoneUse MCP bridge as a local process. The bridge calls the authenticated remote REST gateway over HTTPS. The gateway URL is not a Streamable HTTP MCP endpoint: do not paste it into an “MCP server URL” field.

> PhoneUse supplies observation and physical action tools. Your agent host supplies the model, reasoning, task loop and notification handling. Connecting MCP alone does not create an always-on assistant or subscribe an agent to iPhone push notifications. The browser live feed is available separately in the [Console](/console).

## 1. Install the bridge

Install Node.js 22.13 or newer on the computer running your agent host. Download the standalone [PhoneUse MCP client](https://console.phonefarm.ai/downloads/phonebase-mcp.mjs) and its [SHA-256 manifest](https://console.phonefarm.ai/downloads/phonebase-mcp.mjs.sha256). This client calls your remote station and does not install camera, driver, or local Dashboard services.

```bash
mkdir -p "$HOME/.phonebase/mcp"
cd "$HOME/.phonebase/mcp"
curl --fail --proto '=https' --tlsv1.2 -O \
  https://console.phonefarm.ai/downloads/phonebase-mcp.mjs
curl --fail --proto '=https' --tlsv1.2 -O \
  https://console.phonefarm.ai/downloads/phonebase-mcp.mjs.sha256
shasum -a 256 -c phonebase-mcp.mjs.sha256
```

The checksum verifies that your download matches the published artifact; it is not a separate publisher-signature system. Keep the downloaded file in a stable location and use its absolute path in the host configuration. The client uses Node.js and has no native camera or robot-driver dependency; platform-specific agent-host setup still needs to be verified in your environment.

These download commands use Bash or Zsh on macOS/Linux. On Linux, if shasum is unavailable, use sha256sum -c phonebase-mcp.mjs.sha256. Stop if either download or checksum verification fails; do not run an unverified file. Windows host setup requires equivalent download, checksum, and local-process configuration steps and is not covered by these shell commands.

## 2. Configure the remote connection

Run the setup command below in the same terminal. Paste your private invitation or access code when prompted; input is hidden. Setup verifies your assigned-device access and writes a private configuration with the exact Node.js path, client file path, gateway, and key. No placeholder replacement is needed.

```bash
node phonebase-mcp.mjs --configure
```

Import the generated `phonebase-mcp.config.json` into an MCP host that supports local stdio servers. If the host already has other servers, merge only the `phonebase` entry under `mcpServers`; do not replace the whole configuration. Reconnect or restart the host. Keep this generated file private: it contains your access key.

> Setup refuses to overwrite an existing file. To generate another configuration, run `node phonebase-mcp.mjs --configure ./phonebase-mcp-new.config.json`. If you prefer browser-generated settings, use the connection helper below, enter the full downloaded client path, and explicitly include your private key.

## 3. Give the agent an operating contract

```text
Use PhoneUse to operate only my assigned devices.
List devices and read capabilities first.
Prefer phonebase_open_app or phonebase_tap_text for a visible labeled target; station-side OCR plans and taps from the same fresh frame.
For coordinate actions, inspect the actual image and use its exact frameSequence and viewport. Never assume a fixed screenshot size.
Keep one workflow owner per phone. Submit actions serially and wait for the final receipt.
Verify the actual phone outcome with a new observation; a completed receipt confirms execution, not application success.
On a changed or stale frame, obtain a fresh observation and replan. Retry temporary read failures with bounded backoff.
After an uncertain submission, inspect the existing receipt and retain the exact idempotency key and payload. Never blindly create another action.
Respect access, calibration and synchronization locks. Report a persistent blocker and continue only independent work that remains authorized.
Never perform mechanical Home or claim the workspace is clear.
```

## 4. Verify tool discovery

Ask the agent to call `phonebase_list_devices`, then `phonebase_observe` for a returned ID. This checks connectivity and returns the live safety state, camera image, and exact frame metadata without moving the arm. Only then begin a deliberate workflow.

Updated customer clients discover 18 tools, including phonebase_wait_for_screen. Restart your MCP client after updating the standalone download. Mechanical Home is omitted; it is exposed only to explicitly enabled local operator connections. See [tool reference](/docs/mcp-tools). State-changing tools require an idempotencyKey; read-only tools do not. Reuse the same key and physical arguments after a lost response. A failed receipt, timeout, or unmet expectedScreen is returned as isError; inspect the preserved receipt before retrying.

## Before the first action

- Confirm the returned device ID belongs to your assignment and inspect its live capabilities.
- Open the actual image returned by phonebase_observe. Check the active source, freshness and returned dimensions; a successful request can return a physical-camera fallback when HD Mirror is disconnected.
- Check readiness and synchronization before sending touch actions. Do not apply coordinates chosen from HD Mirror to a differently sized camera image.
- Pause other browser, API, MCP and background workflows on that phone during your task. A hardware command lock does not reserve a whole conversation or workflow.
- Start with a harmless, reversible action and verify the resulting screen. Leave messages, purchases and account changes for explicitly authorized workflows.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The host asks for an MCP server URL | This integration uses local stdio. Configure the downloaded bridge as a local process; the station HTTPS address is a REST gateway. |
| Access denied or no assigned device | Check the invitation, gateway, expiry and device assignment. Use the connection helper; never publish the code or generated configuration. |
| An image arrives but HD Mirror is unavailable | Inspect the source and dimensions. Ask the operator to restore the assigned iPhone USB connection; do not bypass synchronization checks. |
| The phone changes while the agent thinks | Re-observe and replan. Ensure one workflow owner controls the phone. Do not disable stale-frame or recipient checks. |
| An action times out or the result is unclear | Read the existing receipt and inspect the current screen. Avoid a new idempotency key until the previous action is reconciled. |

Share sanitized error codes, request IDs and receipt IDs with your operator. Never share live keys, private invitations or screenshots containing private messages in public support threads. See [errors](/docs/errors) and [retries and concurrency](/docs/reliability).
