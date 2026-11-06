# USB mirror stability — 2026-09-13

Scope: macOS native capture for the attached Phonebase 02 iPhone. No robot movement, API deployment, or calibration changes were required.

## Findings

The previous capture watchdog terminated the entire process after ten seconds without a successful TCP send. Capture starvation and local transport backpressure took the same recovery path. Fleet restart delay and iPhone discovery added further downtime. This explains a recovery weakness; it does not establish the cause of every reported disconnect. The pre-change 120-second observation happened to remain online throughout.

## Changes

- Track incoming samples, successful JPEG encoding, and transport delivery separately.
- For sample starvation, restart the capture session on its own serial queue. Allow two attempts, spaced at least fifteen seconds, before falling back to managed process restart. Initial device startup gets thirty seconds.
- Reconnect a stalled local TCP sender when JPEG encoding is still active, without restarting capture.
- Ignore completion callbacks belonging to an obsolete TCP connection.
- Hold a macOS activity assertion during iPhone capture to prevent App Nap / idle system sleep from interrupting continuous background work. App Nap was not proven to be the original cause.
- Record session events, dimensions, TCP reconnects, and recovery attempts in a bounded local diagnostic log at `/tmp/phonebase-mirror-3122.log`.

Device selection remains tied to its exact configured identity. Existing frame freshness checks and portrait geometry validation remain enabled. A stale picture must not be reported as a live HD stream.

## Validation

Native Swift compilation and application signing succeeded; existing capture-device discovery deprecation warnings remain. `git diff --check` passed for the edited source. The new binary was activated by replacing only the iPhone capture process; the physical camera and arm driver were left running.

Post-change observation: 180 samples over three minutes, zero offline samples, one unchanged native capture PID; maximum API-reported frame age 164 ms. This is frame age at the local API, not measured end-to-end interaction latency.

Controlled interruption: suspended only the native iPhone capture process for eight seconds, then resumed it in a `finally` block. The API correctly marked HD unavailable during starvation. Delivery recovered approximately 1.302 seconds after resume, with the same process ID. The native log confirms the first capture-session restart branch ran and returned with `running=true`. This validates stale-stream detection and recovery from process suspension; it does not independently exercise every capture-session or TCP recovery branch. Raw records are in `.runtime/mirror-stability/after.json` and `interruption.json`. This short verification cannot establish all-day stability or rule out a faulty cable, hub, or iOS capture interruption.
