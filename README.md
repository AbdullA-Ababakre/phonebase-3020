> **3020 live-source snapshot — 2026-11-05**
> This private repository contains the source copied from the running local PhoneUse console (port 3020), including device control, camera/mirror services, and recent Home/Back fixes.
> Real environment files, credentials, customer leases, runtime recordings, hardware bindings, and commissioned device calibration profiles are intentionally excluded. This is a source backup, not a preconfigured station or a new verified release. Existing example profiles and release metadata are legacy fixtures. Read [SF-HANDOFF.md](SF-HANDOFF.md) before deploying to hardware.

# Phonebase Device Platform

## Enterprise evaluation release 0.7.0

Customer onboarding: `/docs/quickstart`. Remote API contract: `/openapi-remote.json`. Standalone MCP client: `/downloads/phonebase-mcp.mjs` with its adjacent SHA-256 manifest. The public website provides product context while localhost keeps the operator Dashboard.

One customer access grant can assign 1–100 devices on the same station; this is an allocation limit, not a qualified hardware capacity claim. Existing single-device keys remain compatible. Upgrade the gateway and control plane together before creating multi-device grants. See `docs/enterprise/DELIVERY.md` for rollout and capability boundaries.

Documentation source lives in `content/docs/pages.json`; `npm run docs:build` exports Markdown, machine-readable guides, and `docs/mintlify`. `npm run mcp:build` creates the portable Node.js client. `npm run test:enterprise` verifies customer isolation and the developer contract.


Phonebase combines a real phone, a UVC camera, and a physical XY/Z robot arm. Operators can control the phone from a local Dashboard. Developers can use the same hardware through REST, WebSocket video, or MCP.

This version supports the Phonebase black arm.

## Start here

The full customer guide is available at:

```text
http://127.0.0.1:3020/docs
```

The same guide is included in the hosted website at `/docs`.

### Station operator installation

```bash
curl -fsSL --proto '=https' --tlsv1.2 \
  https://phonebase.co/install.sh | bash
```

The installer verifies the published package, installs under
`~/.phonebase`, creates the `phonebase` command, installs localhost
background services, and starts guided onboarding. It never homes or moves the
arm.

After installation:

```bash
phonebase status
phonebase doctor
phonebase dashboard
```

When macOS asks, allow **Phonebase Camera** to use the connected UVC camera.
If permission was denied, enable it in **System Settings → Privacy & Security →
Camera**, then run `phonebase restart`.

### Requirements

- macOS
- Node.js 22.13 or newer
- Python 3
- FFmpeg
- Swift command-line tools
- One Phonebase black-arm controller and one UVC camera

### Install from source

```bash
./scripts/setup-macos.sh
npm run local
```

Open:

- Dashboard: `http://127.0.0.1:3020`
- Developer docs: `http://127.0.0.1:3020/docs`
- Control API: `http://127.0.0.1:3013`
- Phone recognition: `http://127.0.0.1:3031`
- OpenAPI: `http://127.0.0.1:3013/api/v1/openapi.json`

With exactly one controller and one camera connected, the fleet runtime discovers them in safe setup mode. It never homes the arm automatically.

## Phonebase CLI

```text
phonebase onboard
phonebase dashboard
phonebase docs
phonebase doctor
phonebase status
phonebase start
phonebase stop
phonebase restart
phonebase repair
phonebase logs --follow
phonebase audit
phonebase cloud-link --copy
phonebase update
phonebase agent-guide --copy
phonebase mcp
phonebase uninstall
```

`phonebase uninstall` removes the background services but intentionally
preserves local configuration, calibration, logs, and application files.

## Optional Cloud Console

The hosted `/console` route provides remote human control without publishing
the localhost API. Complete Home and automatic phone setup on the station Mac
first, then put only the authenticated gateway on port 3015 behind your
company-approved HTTPS tunnel.

Set these values in `.env.supervisor`:

```bash
PHONEBASE_REMOTE_ALLOWED_ORIGINS=https://phonebase.co
PHONEBASE_REMOTE_TOKEN=<32-or-more-random-characters>
PHONEBASE_REMOTE_PUBLIC_URL=https://your-station-gateway.example
```

After the gateway and tunnel are healthy, manage customer access in the local
Dashboard:

1. Open `http://127.0.0.1:3020`.
2. Select **Customer access** in the left rail.
3. Choose an available device and enter the customer name or email.
4. Select **Create & copy access code** and send that single code to the renter.
5. Renew one month or revoke access from the same customer row.

The Dashboard is the normal operator workflow. These CLI commands remain only
as a recovery and automation interface for station administrators:

```bash
phonebase lease create --device black-arm-01 --customer friend@example.com --copy
phonebase lease list
phonebase lease renew <lease-id> --copy
phonebase lease revoke <lease-id>
```

`cloud-link` grants trusted administrator access to the whole station and must
not be shared with renters. Rental creation refuses a second active lease for
the same device. A renter
access code exposes only its assigned devices, expires after one calendar month,
and cannot call mechanical Home or maintenance routes. Renewal preserves the existing
private code; revocation invalidates the current code immediately. The local
registry is stored in `.runtime/rental-leases.json` and survives service
restarts.

The one-click link stores the same access code in its URL fragment, removes it
from the address bar after pairing, and keeps the decoded connection only in
that browser tab's `sessionStorage`. The hosted site
never receives the fragment. Close the tab or use **Disconnect** in the sidebar
to forget the station. Setup and calibration remain local; remote actions still
pass through the same homing, frame freshness, calibration, reach, and receipt
gates.

## Product architecture

### Fixed remote gateway on macOS

#### SF fleet station recovery (PhoneUse deployment)

The deployed SF runtime lives at
`/Users/abdullaababakre/Library/Application Support/PhoneUse/control-console`.
Its `com.phoneuse.station` service does not start remote access. From that
deployed directory, validate and install the separate remote LaunchAgents:

```bash
python3 scripts/install_remote_services_macos.py --check
python3 scripts/install_remote_services_macos.py --without-tunnel
# Verify the named tunnel's origin routes before enabling its connector.
python3 scripts/install_remote_services_macos.py
```

The existing `robothand` named tunnel uses these exact origins:

- `robothand.phonefarm.ai` → `http://127.0.0.1:3015` (authenticated API/video).
- `console.phonefarm.ai` → `http://127.0.0.1:3040` (read-only public frontend).
- Catch-all → `http_status:404`.

The frontend proxies only public pages and assets from the running local 3020
web service. It rejects operator/API routes and write methods and strips
credentials and forwarded-host headers. Do not point the public hostname at
3021: a previously auto-enrolled hardware driver currently owns that port.
New enrollment reserves both 3021 and 3040; this does not relocate existing
drivers. No hardware restart is required for remote recovery.

The installer preserves the existing signing key, connector token and rental
registry. Private file paths must refer to the deployed runtime, not Documents.
It installs `com.phoneuse.remote-gateway`, `com.phoneuse.public-console` and
`com.phoneuse.remote-tunnel`, with login autostart and crash recovery. These are
per-user LaunchAgents: the operator must log in after a reboot, and logging out
stops them. Closing the terminal does not stop them. Keep the station awake.

Logs: `build/runtime/remote/com.phoneuse.*.log`. Readiness:
`http://127.0.0.1:20241/ready`. Restart just the tunnel with
`launchctl kickstart -k "gui/$(id -u)/com.phoneuse.remote-tunnel"`; stop it with
`launchctl bootout "gui/$(id -u)/com.phoneuse.remote-tunnel"` (bootstrap its plist
again to resume). Never use the old remote-session script to recover this fleet:
it targets a different control-plane LaunchAgent and can replace auth settings.

After recovery, check the public `/console` page and its assets, unauthenticated
gateway rejection, existing customer-code authentication, scope isolation and
read-only video. A healthy tunnel does not imply an active lease or online
assigned phone. Do not renew/reassign customers or move hardware merely to make
a connectivity check pass.

For long-lived customer links, use a named Cloudflare Tunnel and a proxied DNS
record for a hostname you control. Route that hostname only to
`http://127.0.0.1:3015`, with a final `http_status:404` ingress rule.
Quick Tunnel hostnames are temporary and must not be used as permanent rentals.

Save the named tunnel's connector token in a private file (`chmod 600`), then
create `.runtime/named-remote.json` (also mode 600):

```json
{
  "version": 1,
  "gatewayUrl": "https://station.your-domain.example",
  "tokenFile": "/absolute/path/to/named-tunnel-token"
}
```

`scripts/start_remote_session_macos.sh` prefers this configuration and passes
the token by file, without exposing it in process arguments. A configured named
tunnel never silently falls back to a new random hostname. Launchd restarts the
session if either its gateway or tunnel process exits. Both children are cleaned
up when the parent exits. The existing station signing key and rental registry
are preserved, so customer links remain unchanged through reconnection and
renewal. Operator-published exact-origin migrations in
`config/remote-gateway-aliases.json` let the hosted console open previously shared
links and saved tab pairings using the fixed gateway, with the original lease
token. Add only gateways belonging to the same station; unrelated stations must
never be redirected. REST/MCP clients should use the fixed API hostname directly.

The console allows at most three video frames in flight, acknowledges decoded
frames cumulatively, and retains only the newest unsent frame. Older clients
without a window parameter keep one-frame backpressure. This avoids waiting a
full round trip between every frame without allowing an unbounded video backlog.

Measure an existing rental without moving the phone or arm:

```bash
node scripts/measure-remote-link.mjs black-arm-02 1
node scripts/measure-remote-link.mjs black-arm-02 3
```

The report contains API time, first-frame time, frame rate, and frame age. Run
both measurements from the same network; these results do not predict every
customer's network latency.

### Local device services

```text
Dashboard :3020
    │
    ├── REST API :3013
    ├── Live WebSocket :3013
    ├── Phone recognition :3031
    └── MCP stdio server
             │
       Control plane
             │
       Black-arm node
        ├── UVC camera
        └── GRBL driver → XY/Z arm
```

- **Devices** provides live video and human control.
- **Station setup** shows camera, controller, homing, and calibration readiness.
- **API & MCP** shows live capabilities, API examples, OpenAPI, and MCP configuration.
- **Control plane** validates every action and tracks final hardware receipts.
- **Fleet supervisor** binds each controller and camera to a stable `deviceId`.
- **Phone recognition** remembers one model selection and safely recovers a verified screen outline after reconnects.

## Hardware setup

For one new arm, connect one controller and one UVC camera, then run `npm run local`.

For a permanent or multi-arm installation:

```bash
cp config/device-fleet.example.json config/device-fleet.json
```

Give each arm a unique:

- `deviceId`
- controller serial path or USB topology prefix
- camera AVFoundation `uniqueID` prefix
- driver port
- verified calibration profile

Do not store a camera number that can change after reconnecting USB. The fleet supervisor refuses ambiguous hardware identity instead of guessing.

The included three-device example uses driver ports `3014`, `3024`, and
`3034`, plus camera-stream ports `3111`–`3113`. Keep `3020`, `3013`, `3015`,
`3016`, and `3031` free for the Dashboard, control plane, remote gateway,
supervisor, and phone-recognition service. All connected devices appear in the
same Dashboard, while REST routes select a device by `deviceId`.

The current remote gateway token is station-wide and is intended for one
trusted operator. Do not share it with unrelated renters. Use the monthly
device-scoped lease commands above so each renter sees and controls only the
devices assigned to that lease.

## Safety model

A physical touch is available only when all conditions are true:

- the requested device and USB identity match;
- a fresh frame exists for that device;
- the controller completed homing for this connection;
- a verified calibration matches the device and frame size;
- the target is inside the verified phone area;
- touch depth is inside the accepted device range; and
- the controller is not in Hold or a fault state.

The Dashboard starts in view-only mode. The operator must explicitly enable control.

Home requires the exact `CLEAR_WORKSPACE_AND_HOME` API confirmation. MCP Home is disabled unless a local administrator sets `PHONEBASE_MCP_ALLOW_HOME=1` after establishing a human clearance process.

## REST API

List devices and current capabilities:

```bash
curl http://127.0.0.1:3013/api/v1/devices
```

Read a screenshot:

```http
GET /api/v1/devices/:deviceId/screenshot
```

The response headers provide:

- `X-Phonebase-Frame-Sequence`
- `X-Phonebase-Frame-Width`
- `X-Phonebase-Frame-Height`
- `X-Phonebase-Captured-At`

Coordinate actions must use the exact sequence and viewport returned for the screenshot used to choose the point. Frames up to 15 seconds old are accepted directly; frames from 15 to 60 seconds are accepted only after the station verifies that the screen and target region are unchanged. Frames older than 60 seconds are rejected.

Submit an action:

```http
POST /api/v1/devices/black-arm-01/actions
Content-Type: application/json

{
  "idempotencyKey": "qa-run-42-step-3",
  "action": {
    "type": "tap",
    "point": { "x": 360, "y": 640 },
    "viewport": { "width": 720, "height": 1280 },
    "frameSequence": 123
  }
}
```

Control-plane actions (mechanical `home` is local operator-only):

- `status`
- `hold`
- `resume`
- `home`
- `hover_move`
- `tap`
- `long_press`
- `swipe`
- `input_text`
- `phone_key`
- `wait`

HTTP `202` means the physical action was accepted. It does not mean movement finished. Read the final receipt:

```http
GET /api/v1/devices/:deviceId/actions/:receiptId
```

Receipt states are `accepted`, `executing`, `completed`, and `failed`.
Receipts are persisted locally with caller-provided `X-Request-Id` and
`X-Phonebase-Actor` values. Unfinished receipts become `failed` after a
control-plane restart; inspect the latest events with `phonebase audit`.

The runnable first-tap example gets a fresh frame and waits for the final receipt:

```bash
npm run example:first-tap -- black-arm-01 360 780 --execute
```

## MCP connection setup

Remote customers should follow [the MCP guide](https://phonebase.co/docs/mcp), download the standalone client, and run `node phonebase-mcp.mjs --configure` with their private invitation.

For a station operator using an installed local CLI, a host that supports local stdio can use:

```json
{
  "mcpServers": {
    "phonebase": {
      "command": "phonebase",
      "args": ["mcp"],
      "env": {
        "PHONEBASE_API_URL": "http://127.0.0.1:3013"
      }
    }
  }
}
```

Customer MCP connections discover 17 tools; an explicitly enabled local operator connection additionally exposes mechanical Home. The server provides tools for devices, screenshots, station-side OCR actions, and receipts. It supports MCP protocol 2026-07-28 and compatible 2025 clients. Prefer `phonebase_open_app` and `phonebase_tap_text` for labeled targets: OCR and the tap are planned from the same fresh station frame, avoiding the slow screenshot-to-coordinate round trip. Coordinate tools still require a fresh screenshot. Action tools wait for the final hardware receipt by default.

Copy the complete machine-readable operating guide for an Agent:

```bash
phonebase agent-guide --copy
```

The same plain-text guide is available at `/agent-guide.txt` on both the hosted
documentation site and the local Dashboard.

Recommended Agent instruction:

```text
Always list devices and read capabilities first.
Get a screenshot before every coordinate action and preserve its exact frame metadata. If model reasoning takes 15–60 seconds, the station revalidates the current screen before touching it.
Use the exact frameSequence and viewport returned with the screenshot.
Never bypass a locked capability; report its reason.
Never home the arm without a human workspace check.
```

Remote MCP connections are blocked unless `PHONEBASE_MCP_ALLOW_REMOTE=1`. Provide `PHONEBASE_API_TOKEN` when using the authenticated remote gateway.

## Automatic phone setup

For a shipped device with its verified hardware profile:

1. Open the Dashboard and click **Complete setup**.
2. Choose the phone model once.
3. Phonebase detects the visible screen and draws four corners over the exact camera frame.
4. Confirm once only when all four corners match the physical screen.
5. Future reconnects use the saved visual reference automatically.

Low confidence, camera resolution changes, excessive drift, or out-of-range
coordinates stop the flow before movement. Choose **Other / Custom** or open
manual calibration when the phone is not in the short supported list.

## Manual calibration fallback

Open:

```text
http://127.0.0.1:3020/calibrate?deviceId=<deviceId>
```

Each profile belongs to one arm, camera frame size, phone placement, and verified touch range. A large fixture or camera change requires manual validation again.

Device profiles are stored in the ignored `build/devices/` directory so one customer's physical coordinates cannot be committed and reused on another arm.

## Production service

Create the production configuration:

```bash
cp .env.supervisor.example .env.supervisor
npm run stable:install
npm run stable:status
```

The local control plane binds to `127.0.0.1` by default. Do not expose port 3013 directly to the internet. Use the authenticated remote gateway for an approved remote deployment.

## Development and verification

```bash
npm run dev:3020
npm run control-plane
npm run vision
npm run fleet
npm run mcp
npm run doctor
npm test
npm run lint
```

Create the checksum-pinned customer download after the validated source is
committed:

```bash
npm run release:macos
```

The OpenAPI 3.1 source is `public/openapi.json`. Treat the live capability response as the source of truth for current physical availability.
