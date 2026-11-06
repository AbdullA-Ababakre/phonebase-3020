# Customer journey verification — 2026-09-13

Scope: local production UI at localhost:3020; real hosted gateway; publicly downloadable MCP bridge. Public website UI has not received these local changes. This is an internal engineering walkthrough, not an observed first-time customer study or complete accessibility certification.

## 1. Browser customer — access passed, hardware blocked

1. Open /console: invitation field and next action visible. Healthy.
2. Paste short access code (one field entry), click Connect workspace (one click): authentication succeeds, customer workspace opens. Healthy.
3. Select assigned device and enable control: blocked; live device list has zero devices. No physical actions sent. Do not count this as a completed control journey.

Screenshot: ../.runtime/customer-journey/01-entry.png. Repeat invitation entry in the helper was observed in 03-helper-before.png and removed. The helper now restores the existing connection in the same tab. Changing invitation only edits the helper; it does not silently revoke or disconnect the Console.

## 2. REST developer — read-only request passed

1. From customer workspace select API & MCP (one click): integration entry visible. Healthy; screenshot 02-integration-before.png.
2. In the connection helper, existing session now needs zero repeated invitation inputs. Enable private key inclusion and copy REST command (two clicks within helper): Copied feedback verified. Healthy.
3. Execute authenticated GET /api/v1/devices: real gateway returns HTTP 200 with zero devices. Healthy connection; hardware use remains blocked.

Counts start at the named surface, exclude URL opening, scrolls and terminal interactions. They are not an end-to-end customer timing benchmark. The automated live request independently uses the same credential and endpoint; clipboard contents were not extracted or executed by browser automation.

## 3. MCP developer — protocol passed, onboarding still needs improvement

1. Install Node.js if absent, download bridge and checksum, verify checksum: public files downloaded and checksum matched. Passed using the existing local Node installation; fresh Node installation was not tested.
2. Open helper with current session, enter full bridge path in one field: JSON updates automatically. Enable private key inclusion and copy configuration: Copied feedback verified. Healthy; removes manual JSON path editing, but path discovery is still manual.
3. Add configuration to an MCP host and restart: not tested in a commercial host UI. Still a manual customer step.
4. Start the downloaded bridge in an isolated temporary directory through an MCP SDK client: initialization, discovery of 15 tools, and phonebase_list_devices succeed against the real gateway. Passed; not proof of every host's configuration compatibility.

No claim of one-click MCP setup. Full paths and host-specific installation remain the largest onboarding gap. The test temporary directory was deleted; credentials are not included in the saved verification report.

## 4. Operator — invitation copy passed, live creation blocked

1. Select Customer access (one click): correct page opens. Healthy.
2. Choose available device(s), enter one customer label, select Create & copy access code: controls visible, but no connected/unassigned device exists, so live creation is correctly disabled. Blocked by hardware availability.
3. For an existing grant, Copy invitation link (one click) produces Copied feedback. Healthy; both short code and link are available again. Screenshot 05-admin-after.png.
4. Create, renew, revoke and enforce grant scope: isolated API fixture tests pass; this is not a completed live operator UI journey. No customer grant was created, renewed or revoked during the browser audit.

The documentation now uses Customer access and Create & copy access code, matching the UI.

## Verification and remaining acceptance gates

38 automated tests passed (19 access/API contracts, 3 MCP protocol tests, 16 rendered HTML checks), TypeScript and targeted ESLint passed, production build succeeded. Later CSS-only adjustment widened the path field and was rebuilt and visually checked. Live results: ../.runtime/customer-journey/live-verification.json.

Before enterprise trial acceptance: bring an assigned device online and verify camera → deliberate enable control → permitted action → receipt; complete configuration in each supported MCP host; repeat these journeys on the published UI. Current local changes are not yet published.

Accessibility limits: labelled fields, explicit copy feedback and disabled unavailable actions are present. Screenshots show small secondary text and dense operator rows; mobile layout, keyboard-only flow, screen-reader announcements and measured contrast were not fully audited in this run.

Evidence: screenshot 04-helper-after.png was rejected because full-page capture displaced sticky elements. Use the final viewport capture 06-helper-final.png for the corrected helper. Screenshot 05 is a scoped viewport of allocation controls, not a full-page capture.

## Captured screens

### 1. Customer entry
![Customer entry](../.runtime/customer-journey/01-entry.png)

### 2. API and MCP entry
![Integration entry](../.runtime/customer-journey/02-integration-before.png)

### 3. Repeated invitation input before the fix
![Helper before](../.runtime/customer-journey/03-helper-before.png)

### 4. Corrected path field and generated configuration
![Helper after](../.runtime/customer-journey/06-helper-final.png)

### 5. Operator invitation copy and unavailable-device state
![Operator controls](../.runtime/customer-journey/05-admin-after.png)

## Hardware follow-up — Phonebase 2 connected

After the operator connected Phonebase 2, USB discovery found a controller and its camera under the same downstream hub. The local runtime binding still referenced the previous USB port. Backed up that configuration to `.runtime/rollbacks/phonebase2-usb-20260913/` and updated only black-arm-02 to serial `/dev/cu.usbserial-212240` and camera `0x21223000bda5858`, then restarted the fleet service with automatic homing disabled.

Verified through the real hosted gateway with the active black-arm-02 customer credential: HTTP 200, exactly black-arm-02 visible, connected=true, cameraReady=true, screenshot HTTP 200 image/jpeg. Inspected the saved frame: live iPhone home screen with a Trust This Computer prompt. No trust choice was submitted. The controller reports homed=false, so physical action acceptance remains outstanding. This supersedes the earlier zero-device observation for this station; it does not imply completion of the physical control or operator creation flows.

The subsequent Node-based MCP recheck was blocked twice by a gateway TCP connection timeout before MCP startup. A curl gateway probe remained reachable (expected unauthenticated 401), and local device/camera status stayed healthy. Therefore the earlier successful customer REST/frame checks stand, but MCP with the newly online hardware is not yet revalidated; transport reliability needs follow-up.
