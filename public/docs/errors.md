# Errors & troubleshooting

Diagnose connection, authorization, and hardware readiness separately.

## HTTP responses

| Status | Meaning | What to check |
| --- | --- | --- |
| 200 / 201 / 202 | Request succeeded or was accepted. | For actions, read the receipt to determine completion. |
| 400 | Invalid request. | JSON shape, required fields, and supported actions. |
| 401 | Missing, invalid, expired, or revoked key. | The decoded Bearer key and grant status. |
| 403 | Access denied. | Device assignment, origin, and operator-only routes. |
| 404 | Resource or route unavailable. | Device ID, receipt ID, and supported remote paths. |
| 409 | State or safety conflict. | Freshness, calibration, readiness, or action identity. |
| 429 | Request rate limit reached. | Reduce action submission rate and back off. |
| 503 / upstream 5xx | Station, frame, or upstream unavailable. | Hardware connection and gateway/control-plane health. |

## Error payloads

```json
{
  "ok": false,
  "error": "This rental lease does not allow access to that resource."
}
```

Some control-plane errors also include a machine-readable `code`; gateway errors may contain only `ok` and `error`. Do not assume every error implements Problem Details or has a code. Preserve the status, error text, receipt ID, device ID, and time for diagnosis.

## Common integration issues

- Docs open but console cannot connect: the docs host and station gateway are separate services.
- curl returns 403 Origin is not allowed: verify the station is running the remote-client compatibility update. Older gateways rejected requests without Origin.
- No devices: ask the operator to confirm your allocation and physical connection.
- Screenshot unavailable: no fresh camera frame exists for this device.
- Tap locked: inspect capabilities.actions.tap.reason; the operator may need to re-home or recalibrate locally.
- MCP tools absent: the host must launch the stdio process with the correct command, environment, and installed dependencies.
- MCP connects locally instead of remotely: set PHONEBASE_API_URL, PHONEBASE_API_TOKEN, and PHONEBASE_MCP_ALLOW_REMOTE=1.

A network timeout before an HTTP response is different from a 401 or 403. Check DNS, HTTPS connectivity, and any required VPN or proxy. Do not disable a network connection you depend on. Use bounded retries for reads; reconcile action receipts before retrying a motion. If an edge service returns a non-JSON 403, preserve its sanitized error and request ID; the official Python example sets an explicit client User-Agent.

## Prepare a useful support report

Send the operator the time with timezone, device ID, endpoint, HTTP status, sanitized error, and receipt ID when available. Describe the last successful step. Remove the API key, invitation fragment, and private phone content.
