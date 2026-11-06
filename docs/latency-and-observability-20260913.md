# Remote latency and station observability — 2026-09-13

## Measured problem

Local live frame age was approximately 16 ms median, while the public gateway returned frames approximately 1,029 ms old. The public HTTP device request median was 689 ms (eight requests). Tunnel diagnostics showed San Jose connections. These observations point to a substantial network-path contribution; they do not isolate every network hop or establish latency from every customer region.

The existing browser also retained its last drawn sequence over reconnects, while control-plane frame sequences restarted at zero. A service restart could make a page reject fresh frames repeatedly until it was reloaded.

## Delivered changes

- Remote preview defaults to Responsive: 240 px encoded width, JPEG quality 38, at most two unacknowledged frames. Sharp remains available for small text. Logical coordinate metadata and original-resolution REST/MCP screenshots are unchanged.
- Cache allowed CORS preflight decisions for 600 seconds; expose request IDs and station processing time.
- Dashboard actions reuse their existing authenticated video WebSocket. Every command revalidates lease access and the same action policy before reaching the existing REST execution path. A missing reply falls back to HTTP with the exact original idempotency key and request ID. This does not authorize replay under a new identity.
- Frame IDs now use a time-based integer range, and reconnects reset browser decode state. A generation check prevents a bitmap from a superseded connection being drawn; skipped frames release flow-control credit.
- Store action, API, gateway, UI, and aggregated stream events in SQLite with WAL, on dedicated worker threads so disk writes and history queries stay off the device-control event loop. The implementation uses [Node SQLite](https://nodejs.org/api/sqlite.html).
- The local administrator's Activity & incidents page supports customer/device/source/severity/time/search filters, cursor pagination, request traces, a current-page JSON export, and incident review. This is the existing local station administrator surface, not a new publicly accessible administrator role.
- Attribute remote customers from authenticated leases. Dashboard/MCP/API source labels remain diagnostic client labels, not authentication evidence. Record request and receipt IDs, requested coordinates, planned mechanical coordinates when present, profile, execution states, durations, and error codes.
- Record UI navigation, controls, view/quality changes, button/link interactions, setup response status, and browser network/unhandled errors. Input values, credential-bearing URLs, typed phone text and images are excluded. Do not log every raw video frame; record stream-window summaries instead.
- Device connection, controller alarm, camera/mirror availability, and sustained camera/mirror mismatch checks run every two seconds with a five-second persistence gate. Sustained sampled client video delay and stream acknowledgement delay create incidents. Persistent problems reopen after manual review; cleared health conditions resolve automatically. No outgoing email or messaging integration was configured.

## Verification

124 TypeScript tests passed, including authentication/tenant isolation, worker-backed log queries, persistence, redaction, cursor pagination, incident lifecycle, and WebSocket action/revocation policies. The real portable MCP client discovered 15 tools and completed a status request through the customer gateway; the administrator log correctly attributed API and MCP results to that lease. Existing events survived the service restart. UI source filtering and the request trace were exercised in Chrome.

A same-station, short-window before/after observation (not a controlled regional benchmark):

| Metric | Previous preview | Responsive preview |
|---|---:|---:|
| Public frame age p50 | 1,029 ms | 412 ms |
| Public frame age p95 | 1,309 ms | 1,016 ms |
| Encoded frame size p50 | 22,540 bytes | 10,792 bytes |
| Frame interval p50 | 353 ms | 239 ms |

The median frame age improved about 60% in these samples; slow outliers still exceeded a second. Frame age is capture/upload timestamp to this test client, not a measured physical tap-to-photon latency. One post-restart attempt received no frames within its sampling interval and was rejected as an invalid measurement; a separate short debug capture and the full subsequent capture succeeded. HTTP timings include network variation and must not be attributed entirely to code changes.

Raw evaluation records are local under `.runtime/latency-observability/`. Controlled tests use temporary data stores. Status checks do not move the arm. Eight real status requests over an existing public video WebSocket returned at a median 573 ms and p95 755 ms; this is a transport/status measurement, not mechanical touch latency.

A controlled native mirror suspension triggered the real `health:black-arm-02:mirror` incident. On resuming capture the incident resolved automatically, with no manual refresh or report required. Both creation and resolution remained visible in the persistent incident history. The final build, typecheck, and 20 rendered-page/MCP tests passed.

## Operating limits and next infrastructure step

The diagnostic store prunes periodically at 30 days or 250,000 events, whichever limit is reached first. It is not an unlimited compliance archive; back it up or extend storage before larger fleet adoption. The export contains the current page, not an unbounded bulk export. The old audit file is preserved; existing historical entries were not retrospectively expanded into new structured traces. Client telemetry is best effort and marked as reported data, and browser clock skew can affect reported frame age. Errors occurring before a customer client connects cannot be centrally observed by this station.

Controller completion does not prove an arbitrary iPhone app registered the intended touch. Camera/mirror correlation detects some mismatches but cannot certify physical accuracy everywhere. Incidents provide evidence and guided review; they do not automatically change calibration or deploy code.

Further reduction requires addressing the station-to-customer path: measure from target customer regions, deploy a relay close to the station/customer where appropriate, and evaluate direct WebRTC video/control with authenticated signaling and a TURN fallback. Those infrastructure changes were not deployed in this update. Keep camera/safety/receipt checks intact when evaluating them.
