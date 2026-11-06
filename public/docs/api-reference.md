# REST API reference

The remote customer contract, generated from the checked-in OpenAPI 3.1.2 specification.

## Base URL & authentication

Use the HTTPS gateway in your invitation, with `Authorization: Bearer YOUR_API_KEY`. Paths already include `/api/v1`; do not append another version prefix to the base URL. [Download remote OpenAPI](/openapi-remote.json).

A short `PB-XXXX-XXXX-XXXX-XXXX` code can be used as a Bearer key for its hosted gateway. A full `pb_connect_v1.` invitation wraps a gateway and key; decode it with the [connection helper](/docs/connect) first. The docs host is not necessarily your assigned API host. Every request, including `/health`, requires authentication.

> A customer key is a credential for the assigned phone, not a public demo URL. Current customer grants include both read and control access. Browser view-only mode is a user-interface setting, not a read-only API permission. See [public demo planning](/docs/public-demo) before putting a device link on a public website.

## Read-only connection check

Set `PHONEBASE_API_URL` to your assigned HTTPS gateway and provide `PHONEBASE_API_TOKEN` through your local secret manager. These requests do not move the arm. HTTP 200 verifies authenticated connectivity; inspect live device state separately before claiming that control is ready.

```bash
curl --fail-with-body "$PHONEBASE_API_URL/health" \
  -H "Authorization: Bearer $PHONEBASE_API_TOKEN"
curl --fail-with-body "$PHONEBASE_API_URL/api/v1/devices" \
  -H "Authorization: Bearer $PHONEBASE_API_TOKEN"
```

Choose an actual device ID from `devices`, read its state and capabilities, then download a screenshot with its metadata headers. Follow the [REST quickstart](/docs/quickstart) for the complete example. Camera fallback, an offline phone, or a locked action must be resolved before your workflow continues.

## Execution and recovery contract

- Keep one workflow owner per phone across browser, REST and MCP clients. Primitive commands are serialized, but there is no guaranteed public visitor reservation or workflow-isolation API.
- Use a unique idempotencyKey for each intended step. After a lost response, inspect its receipt and retain the same key and exact payload; do not create a duplicate action.
- HTTP 202 or an accepted receipt is not completion. Read the receipt until it reaches a final state, then inspect a fresh screenshot for the application result.
- Receipts label completionScope as physical_execution and uiVerification separately. GET /api/v1/devices/{deviceId}/screen-state supplies bounded OCR postcondition checks without sending an action. Read verification.matched, scope and evidence; a 200 response alone does not mean the condition matched.
- Coordinate actions must use the exact screenshot frameSequence and viewport. Prefer station-side visual actions for visible text or app names when appropriate.
- A shared key shares an access identity and its action rate budget. The current 50 submissions per 5 seconds limit is an abuse guard, not guaranteed physical throughput or a fair-use queue.

For 401/403, fix access or assignment. For 409, inspect the returned code, readiness and current frame. For 429, back off. For temporary 5xx read errors, retry with a bounded deadline. An uncertain write requires receipt reconciliation first. See [errors](/docs/errors), [frames](/docs/frames) and [reliability](/docs/reliability).

## Endpoints

### GET `/api/v1/devices/{deviceId}/screen-state`

Check a bounded visible screen postcondition without motion

Literal OCR on fresh synchronized frames. timeoutMs > 0 requires two distinct matching frames. HTTP 200 is a completed read, not a matched condition: inspect verification.matched. Bounds should isolate the actual field, excluding suggestions/history. A match is limited to visible evidence, not entire workflow success. No physical retry or account provisioning occurs.

Response statuses: 200, 400, 401, 403, 404, 429, 502, 503. See [remote OpenAPI](/openapi-remote.json) for full request and response schemas.

### GET `/health`

Check authenticated gateway connectivity



Response statuses: 200, 401, 403, 429, 502, 503. See [remote OpenAPI](/openapi-remote.json) for full request and response schemas.

### GET `/api/v1/devices`

List assigned devices



Response statuses: 200, 401, 403, 429, 502, 503. See [remote OpenAPI](/openapi-remote.json) for full request and response schemas.

### GET `/api/v1/devices/{deviceId}`

Get one physical device



Response statuses: 200, 401, 403, 404, 429, 502, 503. See [remote OpenAPI](/openapi-remote.json) for full request and response schemas.

### GET `/api/v1/devices/{deviceId}/screenshot`

Read the latest or an exact recent frame



Response statuses: 200, 401, 403, 404, 429, 502, 503. See [remote OpenAPI](/openapi-remote.json) for full request and response schemas.

### POST `/api/v1/devices/{deviceId}/actions`

Submit one safe physical primitive

Coordinate actions bind to an exact observed frame. Frames up to 15 seconds old are accepted directly; from 15 to 60 seconds the station compares the observed screen and target region with the current frame and proceeds only if they remain unchanged. Frames older than 60 seconds are rejected. Customer keys cannot perform mechanical Home. Read capabilities first and wait for the final action receipt.

Response statuses: 200, 202, 400, 401, 403, 409, 429, 502, 503. See [remote OpenAPI](/openapi-remote.json) for full request and response schemas.

### GET `/api/v1/devices/{deviceId}/actions`

List recent action receipts for one device



Response statuses: 200, 401, 403, 404, 429, 502, 503. See [remote OpenAPI](/openapi-remote.json) for full request and response schemas.

### POST `/api/v1/devices/{deviceId}/visual-actions`

Locate and tap one labeled target with station-side OCR

The station reads its latest fresh frame, returns to the phone Home Screen when an open_app target requires it, resolves one bounded app or text target, and submits the calibrated tap from the same fresh target frame. Prefer this endpoint over a screenshot-to-coordinate round trip for visible labels. Customer keys cannot perform mechanical Home. Read capabilities first and wait for the final action receipt.

Response statuses: 200, 202, 400, 401, 403, 409, 429, 502, 503. See [remote OpenAPI](/openapi-remote.json) for full request and response schemas.

### GET `/api/v1/devices/{deviceId}/actions/{receiptId}`

Read final physical action state



Response statuses: 200, 401, 403, 404, 429, 502, 503. See [remote OpenAPI](/openapi-remote.json) for full request and response schemas.

## Local operator contract

The [local OpenAPI specification](/openapi.json) additionally describes operator calibration routes. These are not available through customer grants. The versioned URL identifies the API family; live responses also include a protocolVersion.
