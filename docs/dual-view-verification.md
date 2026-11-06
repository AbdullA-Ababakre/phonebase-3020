# Dual phone views — local implementation, 2026-09-13

Device tiles and focus mode expose Camera and HD mirror. Switching remounts the stream and resets frame/control readiness. Mirror view only accepts the wired iPhone source; unavailable mirroring cannot silently display a camera frame. Touch and phone navigation require a live frame from the selected source. Physical actions remain subject to the existing controller and calibration gates.

Native CameraBroker can capture an explicitly selected USB iPhone through Apple's CoreMediaIO opt-in and AVFoundation muxed source. This path does not use the capture-card crop. It accepts portrait 19.5:9 frames within a narrow tolerance and outputs 720×1560 JPEGs; other aspect ratios produce no usable frames and need a separate tested profile. Sources match an exact capture-device identity. Each device has its own mirror listener and broker process; a missing mirror does not terminate the physical camera broker.

Fleet optional configuration: `digitalIdentity` (exact AVFoundation identifier) and `digitalStreamPort` (unique local port). The native app must be built with scripts/build-camera-broker-macos.sh. Do not auto-select the first attached iPhone. Duplicate mirror assignments are rejected. These identifiers have not been written into the active fleet config: two iPhones are attached and the operator has been asked which belongs to Phonebase 2.

Observed locally: Camera displays the connected phone, HD mirror correctly reports Offline with no substituted camera image, and returning to Camera restores the source. Native Swift compilation, TypeScript and targeted ESLint pass. Existing 16 rendered checks pass; auto-setup, screen detection and gateway tests pass, including stale-reference recovery without calibration writes and disconnected-reflection rejection. No phone touch or Home command was sent for these checks. Actual mirrored frames, disconnect/reconnect behavior with the selected phone and physical coordinate agreement remain to be verified after source identification. Public website not updated.

Screen recognition fix: an outdated reference now triggers fresh detection and manual baseline review instead of an unrecoverable manual_review loop. Old corners are explicitly labelled as previous calibration. Disconnected bright fixture reflections no longer extend the luminous-screen candidate. The current dark home-screen frame still has no reliable automatic proposal; no guessed calibration was activated.

Apple API reference: https://developer.apple.com/documentation/coremediaio/kcmiohardwarepropertyallowscreencapturedevices

![Mirror unavailable state](../.runtime/customer-journey/dual-mirror-offline.png)

## Live acceptance after camera authorization

The user identified the device named iPhone as Phonebase 2 and completed macOS camera authorization. The active fleet now binds that exact AVFoundation identity to black-arm-02 on mirror listener 3122. Native capture uses the high session preset: observed source 828×1792, normalized output 720×1560. Camera and mirror both report ready. Saved JPEGs from both sources were inspected and show the same physical phone's home screen.

Browser verified: Camera → HD mirror → Camera, then focus mode → HD mirror. Both the device tile and focus mode render the selected live source. Customer-authenticated hosted gateway requests return 200 image/jpeg for both the default mirrored screenshot and `?source=camera`.

Fixed a discovered integration regression: auto-setup formerly fetched the default screenshot, which becomes a mirrored screen while mirroring is active. Semantic device metadata and screenshots now accept `source=camera`, and auto-setup always requests that source. Exact-sequence camera requests reject non-verification frames. Auto-setup again reads 720×1280, returns baseline_required and does not report a false resolution mismatch. The camera fallback in LiveScreen also explicitly requests camera metadata.

Validation: native Swift build, TypeScript, targeted ESLint, 6 auto-setup/gateway/contracts tests and 16 rendered checks passed. This run performed no physical movement. Mechanical homing and final four-corner confirmation remain required; physical tap accuracy has not been accepted. Public website UI is still the previously published version.

![Live mirror focus mode](../.runtime/customer-journey/mirror-focus-final.png)

## Mirror stall recovery

Observed an iPhone capture process remaining alive while producing no usable frames. Restarting that mirror process restored HD video. Added a native mirror-only delivery watchdog: after 10 seconds without a successfully delivered frame (checked every 2 seconds after initial startup), the capture process exits with code 75 so fleet supervision recreates it. A separate no-listener test on port 3132 verified the timeout message and exit code 75. Waiting TCP connections now cancel and reconnect instead of remaining stuck.

Physical broker cleanup now targets only physical capture instances from this installation instead of killing every process named PhonebaseCameraBroker. Fleet startup cleans orphaned capture processes left by a terminated supervisor. The authorized app launch path is retained; direct launch from the background service did not receive camera permission and was rejected during testing.

Swift compilation, TypeScript and fleet ESLint passed. Actual recovery observations are recorded in ../.runtime/customer-journey/mirror-recovery-check.json. No mechanical motion was requested.
