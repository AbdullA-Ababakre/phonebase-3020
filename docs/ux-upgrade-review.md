# Phonebase workspace UX upgrade

Reviewed September 13, 2026. Scope: existing customer connection, documentation onboarding, local device workspace, station setup, and developer integration surfaces. The intended outcome is that an invited customer can identify the next step, find assigned devices, and choose browser, API, or MCP access without learning station administration first.

## Evidence and findings

Screenshots were captured from the public v0.7 site and the running local app before changes, saved locally, opened, and reviewed. Comparison images live in `../.runtime/ux-audit/`. The device-grid evidence uses the existing explicitly identified demo mode; it is not evidence of live hardware operation.

| Step | Experience | Before | Resolution / current health | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Customer invitation | A code-only form explained hardware internals; customers with only a docs link had little guidance. | Link-or-code form, three-step orientation, invitation help, explicit validation and recovery. Implemented; malformed input tested. | `01-console-before.png`, `01-console-after.png`, `08-console-mobile.png` |
| 2 | Documentation entry | Introductory banner occupied the initial viewport before task choices. | Direct browser, REST, and MCP entries; larger navigation and body text. Implemented and inspected. | `02-docs-before.png`, `02-docs-after.png`, `09-docs-mobile.png` |
| 3 | Empty device workspace | Icon-only navigation, disabled action toolbar, terminal command without a setup action. | Labeled navigation, operator/customer context, clear setup or connection action, automatic-refresh explanation. Implemented and inspected. | `03-dashboard-before.png`, `03-dashboard-after.png`, `10-dashboard-mobile.png` |
| 4 | Station connection | Marketing-sized heading and setup instructions dominated the task; hardware instructions also existed in remote customer mode. | Concise setup heading, readable instructions; remote customers get readiness and operator guidance. Local layout inspected; remote branch reviewed in source. | `04-connections-before.png`, `04-connections-after.png`, `11-setup-mobile.png` |
| 5 | Getting started | Browser users encountered an API-oriented sequence before choosing an interface. | Browser/API/MCP selector shows the relevant instructions, with shareable path selection. All three paths tested. | `05-quickstart-before.png`, `05-quickstart-after.png` |
| 6 | Device operation | Device identity was below the phone frame, and the options button only selected a device. | Identity and readiness at the top; details actually opens the inspector; clear search recovery; demo mode prominently labeled. Tested with simulated devices. | `06-device-demo-before.png`, `06-device-demo-after.png` |

Existing strengths retained: view-only default, live capability checks, operator-only physical setup, searchable technical documentation, and machine-readable OpenAPI/Markdown/MCP resources.

## Further implementation details

- Invitation submission verifies the assigned-device endpoint rather than treating gateway health as authorization. Connection attempt has a 15-second timeout.
- A connection prepared in the documentation helper can continue in the same tab without pasting the invitation again. The Console still verifies access with the station.
- The customer `/console` path stays a customer invitation flow when previewed locally; the local operator root remains available.
- Developer workspace starts with REST/MCP guides and a read-only list request. Capability matrices and endpoint details are progressively disclosed.
- API keys are excluded from examples by default. Customer invitation URLs are collapsed until intentionally opened; copy controls remain available.
- Remote users do not see position setup buttons or station installation instructions.
- Hold-all feedback counts accepted requests and no longer claims every request succeeded after a partial failure. Disabling browser control is distinct from stopping physical motion.
- Navigation, form labels, focus indicators, search-button accessible name, pressed states, and status/error announcements were improved. Reduced-motion preferences are supported.
- Generated Markdown, Mintlify MDX, and LLM indexes were updated from the same documentation source.

## Verification and limits

TypeScript and targeted ESLint checks pass. Six endpoint/documentation contract tests and sixteen rendered-output regression tests pass. Browser checks covered invalid invitation recovery, documentation path changes, search no-results and Escape, mobile navigation, device filtering, detail opening, and simulated control on/off. Desktop before/after images were reviewed together. The 390px mobile checks showed no page-level horizontal overflow on the inspected entry, docs, workspace, and station setup surfaces.

The preview on port 3021 is outside the running API's allowed browser origin, so its live connection state is not a hardware-health test. Final local runtime verification must use `http://localhost:3020`, the configured API origin.

The real station currently reports no devices and no fresh camera frame. No real motion, calibration, customer-grant mutation, or live tenant login was performed for this UI review. The upgrade does not introduce account/password login, SSO, new hardware capabilities, or a WCAG conformance claim. Keyboard-only physical control, screen-reader end-to-end usage, and live customer task completion need separate acceptance with connected hardware and customer feedback. No measured usability improvement is claimed without that evidence.

Final runtime check: the verified production build is installed at `http://localhost:3020`. The running local connection was confirmed healthy in the browser. Six principal routes returned HTTP 200. Malformed invitation URLs show an error after hydration and clear the fragment; malformed form input also shows an actionable error. The customer-grant registry is byte-for-byte unchanged. The previous production build is retained in `.runtime/rollbacks/pre-ux-20260913/dist`. Public deployment has not been performed.
