# Authentication & access

One invitation connects the browser, REST API, and MCP to the same assigned devices.

## Know your credentials

| Credential | Purpose |
| --- | --- |
| Customer link | Opens `/console#access=…` and pairs the current tab. |
| Access code | Short hosted codes use `PB-XXXX-XXXX-XXXX-XXXX` (16 random characters in four groups, plus the PB prefix). Legacy `pb_connect_v1.` codes still work. |
| API key | A short PB code or decoded `pb_lease_v2.…` token, sent as a Bearer credential. |
| Station admin token | Full station authority. For operators only; never distribute as a customer key. |

## Authenticate requests

```http
Authorization: Bearer YOUR_API_KEY
```

Send the key in the `Authorization` header for REST. Browser requests must originate from an origin allowed by the station. Non-browser REST and MCP clients can omit Origin; authentication and device restrictions still apply. Cookies and account passwords are not used by this API.

## Device isolation

A customer grant assigns one or more devices on a single station. List, screenshot, action, receipt, and live-video requests are checked against that assignment. Customers cannot access local administration, calibration, or mechanical Home. Receipt history is scoped to the current grant.

> Members sharing a key share authority and audit identity. Individual member accounts and granular read-only keys are not implemented. Use separate allocations where separate authority is required.

## Expiry, renewal, and revocation

- Access lasts for its configured calendar-month period. The operator can renew it.
- Current v2 customer links remain stable across renewal and station restart.
- Revocation or expiry rejects subsequent requests. Live connections periodically re-check the grant and close when it becomes invalid.
- Revocation is an authorization operation, not a physical emergency stop. An accepted motion may already be executing; the station operator retains Hold and physical power control.
- For a compromised key, revoke the grant and create a new one. Do not paste private links into tickets, public repositories, or screenshots.

## Browser handling

The console removes the invitation fragment after pairing and stores the connection in sessionStorage for that browser tab. Select Disconnect in the console sidebar to clear it. The invitation fragment is not sent with the HTTP request to the documentation host. Browser session restoration may restore tab data; explicitly disconnect on shared computers.
