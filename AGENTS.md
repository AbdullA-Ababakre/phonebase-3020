# San Francisco station handoff

Read `SF-HANDOFF.md` before starting services or touching hardware.

This is a source snapshot for deploying a new Phonebase station on a macOS computer in San Francisco. There are 11 available test machines; only one is currently connected. The goal is customer access through the hosted web console and REST/MCP, with device allocation and isolation.

## First-session scope

Inventory macOS, dependencies, connected USB controllers/cameras, existing processes, configuration and permissions. Establish one device in view-only mode first. Verify local services and a fresh camera frame, then coordinate with a physically present operator for Home, calibration and one controlled action. Do not register disconnected machines as online. Scale only after single-device acceptance.

## Physical operation constraints

- Do not run `npm run black` or `start-black.sh` during onboarding: that legacy path can automatically home and move the arm.
- Inspect every startup path before running it. Use fleet view-only discovery with automatic Home disabled. Do not install a supervisor or launchd service before checking its startup behavior and configuration.
- Never Home or execute motion without a physically present person confirming workspace clearance and the specific intended action. Remote desktop access does not establish clearance.
- Do not enable manual-reference recovery, maintenance bypasses, larger offsets, or restored coordinates for a new device. `.env.supervisor.example` contains a special failed-sensor demo configuration; it is not a production default for this station.
- `build/*calibration*.json` are legacy source/test fixtures retained for code compatibility. Never assign them to this station's machines. Set explicit new device IDs, `profileId: "unconfigured"` and new device-specific calibration paths; verify actual live capabilities stay locked before setup.
- Do not copy original station `.runtime`, leases, signing secrets, tunnel credentials, USB identities or profiles.
- Preserve fresh-frame checks, exact viewport/frameSequence, homing/calibration gates, device identity checks, idempotency and final receipts. HTTP 202 is not completed motion.

## Delivery constraints

- Keep physical control services bound to localhost. Only the authenticated remote gateway on 3015 is eligible for HTTPS tunneling.
- Use a new station signing secret and a new persistent station hostname. Do not route the new station to `gateway.phonebase.co` unless its owner explicitly provisions that destination for this station.
- `config/remote-gateway-aliases.json` belongs to the original station and is retained for regression tests. Before publishing this new station's client/site build, remove those migrations or replace them with exact aliases owned by this new station; update the associated tests.
- Never put administrator/station tokens in NEXT_PUBLIC settings or give administrator links to customers. Use device-scoped customer access codes.
- Do not republish the source package's old installer/release metadata as a new verified release. Build and checksum a new release after deployment validation.
- 11-device capacity is unverified. Validate in increments (1, 2, 5, 11) and measure USB/camera bandwidth, frame age, disconnects and recovery.
- Do not replace the existing public website or change its domain until the intended destination and access are established.

Report commands, errors, connected hardware identities, modified files and acceptance evidence. Do not claim physical or remote acceptance from mock tests.
