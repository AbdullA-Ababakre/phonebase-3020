# Actions & receipts

Compose reliable workflows from physical primitives with explicit completion states.

## The control loop

```text
Read device capabilities
  → capture a fresh screenshot
  → choose a point on that image
  → submit an action with a unique idempotency key
  → wait for completed or failed
  → inspect a new screenshot
```

## Submit an action

Send a JSON action envelope to `POST /api/v1/devices/{deviceId}/actions`. The following is a structural example. Replace the coordinates and frame metadata with values from a real, fresh observation. A normal tap permits only 30–40 ms of commanded mechanical dwell and defaults to 40 ms. Longer contact must use the explicit `long_press` action because the phone also observes mechanical contact and retraction time.

```json
{
  "idempotencyKey": "YOUR_UNIQUE_WORKFLOW_STEP_ID",
  "action": {
    "type": "tap",
    "point": {
      "x": 360,
      "y": 640
    },
    "viewport": {
      "width": 720,
      "height": 1280
    },
    "frameSequence": 123
  }
}
```

> A receipt marked completed confirms hardware execution, not that the phone application achieved your intended outcome. Verify the next screenshot.

## Follow the receipt

| State | Meaning | Client behavior |
| --- | --- | --- |
| accepted | The job has been accepted. | Keep the receipt ID and poll. |
| executing | Physical execution is in progress. | Do not submit a dependent action. |
| completed | The physical operation finished. | Observe again and verify the application state. |
| failed | Execution did not complete successfully. | Stop and inspect the reported failure. |

Read `result.receipt.id` from the submission response, then `GET /api/v1/devices/{deviceId}/actions/{receiptId}`. The polling response places the receipt at `receipt`. HTTP 202 is acceptance, not completion. Every action returns a receipt, including synchronous status and wait (HTTP 200). Retrying an identical request with the same idempotencyKey returns that receipt; changing the action under an existing key returns HTTP 409 IDEMPOTENCY_CONFLICT.

## Available primitives

| Action | Required context |
| --- | --- |
| status / hold / resume | Selected device; resume only when allowed. |
| hover_move / tap | Point, viewport, and frameSequence. |
| long_press | Point, viewport, frameSequence; durationMs 500–5000. |
| swipe | Start, end, viewport, frameSequence; durationMs 250–3000. |
| input_text | Text up to 120 characters; the standard iOS English keyboard must be visible. Send the complete value in one action. |
| phone_key | A key reported in supportedKeys: back, home, or enter. |
| wait | durationMs up to 5000. |

Mechanical `home` is restricted to the station operator. Customer access cannot enable it by setting an MCP option.

## Restarts and uncertain outcomes

Receipts are persisted by the control plane. Unfinished receipts become failed when it restarts, because the software cannot infer what physical work completed during interruption. Observe the real phone before deciding how to recover.

## Trace a request

Send an optional X-Request-Id header (1–160 letters, digits, dots, underscores, colons, or hyphens) to correlate transport and action receipts. The gateway returns X-Request-Id. Official Dashboard and MCP clients identify their source with X-Phonebase-Client; this label is diagnostic, not an authentication credential. The authenticated rental lease remains the authority for customer attribution and device access.
