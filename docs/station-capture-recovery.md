# Station capture reliability — 2026-11-02

The fleet now owns one signed capture process per physical camera. Adding or removing a camera reconciles only that binding. A failed capture retries with bounded backoff; a healthy capture is retained. `capturePriority` (0–100) controls startup order and launches are spaced to avoid opening all USB streams at once. The current station prioritizes sf-black-arm-04.

On macOS, capture-session startup was overriding the requested camera format with 1920×1080. The native runtime now reapplies and logs the selected format after startup and recovery, prefers supported NV12 formats, and limits physical-camera encoding to 15 FPS. This does not establish the camera's sustainable end-to-end rate. The original effective 1080p field of view is retained for 04; calibration and customer authorization files were not changed.

`start-local.sh` restarts an exited Dashboard without exiting and triggering fleet cleanup. Full station shutdown still cleans up its children. The device UI reports Available, Reconnecting video, Setup required, Paused, or Needs attention from actual capabilities. It does not mark a stale image or an unhomed controller available. The UI counts live video separately from connected nodes.

## Verified

- Swift optimized build and bundle signature verification.
- 44 targeted TypeScript tests, one mocked station/frontend lifecycle integration test, scoped application/fleet type checking, and production frontend build.
- Live frontend restart retained the existing control-plane and 04 driver processes.
- Terminating 05's capture restarted 05 while retaining 04's capture PID and advancing frames.
- Six device nodes are listed in the deployed Dashboard.
- Hash comparison confirmed the three existing checked calibration/lease files were unchanged.

## Outstanding physical acceptance

Six simultaneous fresh camera streams have NOT passed. All six UVC cameras were on one USB 2.0 branch. In isolation, 04 produced fresh frames; restoring all captures left several without samples. Shared bandwidth or power remains an unresolved hypothesis requiring cable/hub/controller distribution and measurement. Do not present this as six qualified customer-ready devices.

The owner approved pausing setup and switching station services. Drivers restarted with automatic Home disabled. Controllers therefore require a fresh, physically supervised Home; several already report hardware Alarm. No Home, motion, touch-depth change, or calibration write was executed during this repair. Existing placement must be visually checked before reusing a profile, and the optional iPhone HD mirror remains unavailable.


## 2026-11-02 calibration and recovery acceptance

04 remained on its original driver PID 53927 and physical capture PID 54144 throughout commissioning. The final 30-second sample had 21/21 fresh observations for both 04 and 05, with maximum frame ages of 98/97 ms. This is a bounded observation, not six-camera capacity acceptance.

05 has a newly measured device-specific four-point profile and real app-tap/Home acceptance. Its Home navigation includes a separately tested bottom-edge recovery. Preserve that navigation when saving references: model-default navigation must not overwrite commissioned per-device gestures.

01's new camera-only candidate did not pass bottom-gesture acceptance and was rolled back to this existing device's own prior touch-measured profile. Current real tap and Home acceptance then passed. Its delayed 1200 ms interactive hover was set to zero, eliminating a collision between subsequent operations and automatic parking. The Home observer now selects a fresh frame at least 900 ms after the completed action. No new numerical precision claim is made for either device.

06 has geometric points but FAILED touch acceptance: taps and a 3-second blank-background long press at the maximum permitted Z=10 produced no visible response. No limits were expanded. 07 failed X-input release after 8 mm; 08 failed Home with Alarm. Neither failure was bypassed or repeatedly homed.

Actual 640x360@30 capture was tested for the non-04 devices and did not establish six concurrent fresh streams. Original quality settings and all nonzero camera ports were restored. Capture priorities remain 04=100 and 05=90. Other devices can become video-unavailable under the present shared USB topology.

An initially unsupported capture-size edit exposed an unhandled live configuration rejection that exited Fleet while existing drivers/captures continued. Fleet now catches reload failures and validates initial configuration before touching hardware. Verified process adoption checks station working directory, script, listener and the driver's actual serial. Existing homing remains in the driver; adoption never invents or restores a homing reference. A single-owner file prevents two managers, and a recovered manager follows the station owner's lifecycle. Current Fleet PID is 44792; its owner is start-local PID 53665. The control plane is PID 29153. Runtime owner record: .runtime/fleet-supervisor.json. Recoveries are logged in .runtime/fleet-recovered-managed.log.

Validation: 24 targeted TypeScript tests, one frontend restart lifecycle test, scoped Fleet/adoption TypeScript check, real rejected-config continuity, duplicate-manager prevention, and real per-device final receipts. Customer-wide external access, numerical precision and six-device simultaneous delivery remain unqualified. Do not label 06/07/08 accepted because geometric calibration or a physical motion receipt exists.


## 2026-11-02: 10 concurrent phone requirement and current video protection

The requirement is ten simultaneously live and operable phones; switching between cameras does not qualify. Current runtime policy protects 04 and selects 01, with maximumActiveCameras=2. All six nodes and original driver processes remain online. The focus API and explicit Video standby label are a temporary recovery mechanism for the present wiring, not ten-device acceptance. The fleet owner is PID3812 and control plane PID4639 at this snapshot; do not rely on these PIDs for later lifecycle decisions.

The native broker now holds the AVCaptureDevice configuration lock through startRunning, preventing the session from silently resetting requested capture dimensions. Actual 640x360 samples were confirmed, but this did not establish six-way concurrency. Non-04 production capture settings were restored to 1280x720@30, and all configured camera stream ports are nonzero. The 04 capture process was never restarted during this recovery.

Read-only USB inspection found four AppleT8132USBXHCI roots. All seven enumerated UVC cameras (six paired plus one unpaired) share the same USB2 branch below root0x02000000. Two roots are empty; another contains a USB flash drive. Cached configuration descriptors for 0bda:5858 show alt7 wMaxPacketSize=0x1400, bInterval=1; both live01 and04 select alt7. Its maximum isochronous payload allocation is 3072 bytes/125us =196.608Mbps per camera; three exceed one480Mbps USB2 link before overhead. This is a reservation envelope, not measured JPEG traffic. More USB3 hub sockets on that same branch do not solve it.

For ten at this mode, plan at least five independent USB2 upstream links, at most two cameras per link, and independently powered distribution. Use available host links first, verify additional host-controller expansion if required, and validate 2/4/6/10 in stages. Physical USB path is part of camera identity and serial paths, so re-pair one known device at a time after cable moves. Do not blindly retain old location identities or bind cameras by their duplicate serial numbers.

`scripts/audit-video-capacity.mjs` is a read-only concurrent checker (default60s,target10). It records no images or secrets and sends no actions or focus changes. It checks connected count plus per-device fresh-frame FPS, P95 age, max gap, and socket errors, and records USB topology and video policy. Exit1 means the configured target did not pass. Video acceptance does not prove touch accuracy, physical concurrent operations, or external customer connectivity.


## 2026-11-02: target01/04/05 camera rebind preparation

User requires01,04,05 simultaneously live.05 is still at its old camera location on the shared USB2 branch; three-way acceptance remains false. Do not turn the two-slot policy into three and claim completion without fresh concurrent frames.

Camera-only explicit rebind now retains the original driver and homing reference, verifies controller identity/idle state, replaces only the affected node, and defers changed-camera capture until that node matches the binding. Controller/driver-port changes cannot inherit homing.13 focused tests and scoped TypeScript check passed. Manager78580 adopted all six drivers/nodes; original04capture54144 and01/04/05driverPIDs remained. Actual01/04frame sequences continued advancing after cutover;05 remained standby.


## 2026-11-02: no-rewire third-camera experiment and cadence repair

User confirmed nobody onsite to move cables. A bounded isolated test changed only capture policy temporarily (04 only), then captured01 and05 as YUY2 960x540@10 into separate local TCP sinks. No test frames were published as customer control frames and no motor action was sent.01 produced about6.7fps,05 produced zero frames;04 also stalled during this experiment. Both test captures were stopped and the original01+04 policy restored in finally. Actual01/04 sequence continuity and frame ages under150ms were reconfirmed;04original process54144 and all motor drivers remained. This was a FAILED three-way experiment, not acceptance. Do not repeat third-camera allocation on the shared branch while04 is in use.

Read-only GET_CUR probe and commit requests (no device open/seize, no SET requests, protected04skipped) confirmed05 really negotiated formatIndex2,frameIndex6,frameInterval1000000(960x540YUY2@10), yet dwMaxPayloadTransferSize remained3072bytes. The raw format did not produce a lower USB reservation on this device/driver combination.

FrameSink now uses deadline-based CaptureCadence with bounded jitter tolerance. The previous last-arrival-time comparison dropped extra frames whenever callbacks landed slightly early. A deterministic Swift regression check verifies15fps jitter does not collapse to half rate,30fps is limited to15fps across a minute, and pause recovery does not create catch-up bursts. Native compilation/codesign succeeded; only01capture restarted into this change (PID90315 at snapshot), with unchanged1280x720@30,geometry,anddriver homing.04remains its original mapped executable; its process was not restarted. A fresh60second live audit records the actual effect separately; ten/three-device acceptance remains false.

Actual post-cadence60s result:01=898fresh frames,14.966fps,maxGap133ms;04=485fresh frames,8.083fps,maxGap169ms;05=0frames(intentionalstandby). Three-way acceptance FAILED. Local metadata ages are not end-to-end sensor/browser latency.

Authenticated public customer WebSocket read check using existing scoped grants and actual Console auth/Origin succeeded after cadence repair:20s,01=287frames(14.42fps),04=159frames(7.96fps),zero socket errors,maxGap164/186ms. This was read-only; no new physical touch acceptance or third-camera acceptance is implied. Initial test-client Bearer-only WebSocket attempt was unsupported by the gateway and was corrected to the same query-token protocol used by the Console; no production auth weakening or gateway changes were made.


### Additional three-phone delivery check — 2026-11-02T20:33:43.488163+00:00

No production code or camera policy changed. Existing 01/04 camera brokers and all motor drivers were retained. Phone USB screen discovery completed successfully but returned zero muxed devices; an isolated capture of the exact configured 04 phone identity returned no frames and exited unavailable. There is one connected USB mobile device, but its read-only battery queries returned GetProhibited; battery/sleep cause is unknown. No trust/pairing state was changed.

An ordinary, non-seizing open of idle05 streaming interface1, confirmed alternate0, returned kIOReturnExclusiveAccess (0xe00002c5). No stream, alternate-setting, probe/commit mutation, detach, reset, or firmware write was performed.

Current physical observation revises readiness: both01 and04 show dark phone screens despite fresh camera frames. One normal calibrated center tap on each completed (04 action-22fc5b58-dde0-4415-b81e-dcce3a58bb0e;01 action-403b5679-14d4-4d16-b8e8-61d18f749134), but neither visibly woke. Controller completion is not successful phone interaction. Customer handoff is not verified; the prior two-device limited trial is historical, not current acceptance.05 remains standby.

Evidence: chat outputs/three-phone-delivery-blockers.json and updated customer-readiness-current.json.
