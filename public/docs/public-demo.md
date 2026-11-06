# Plan a public device demo

Separate a safe website trial from a private customer control link.

## Current release and proposed controls

> This is a launch plan, not a claim that public trial sessions are implemented. Do not publish an existing customer invitation as an anonymous demo. Anyone holding that credential can use its assigned device access until expiry or revocation.

| Area | Current behavior | Needed for a public trial |
| --- | --- | --- |
| Access | Customer grants include device read and control scopes | Separate viewer and controller permissions, with a fresh short-lived session for each visitor |
| Sharing | Grant expiry, revocation and device assignment are checked | Visitor admission, one controller per phone, a queue and server-enforced session expiry |
| Actions | Frame, calibration, reach and hardware command checks | A server-enforced demo action policy plus OS-level app restrictions |
| Traffic | Action submissions are limited per access principal | Per-visitor and per-device budgets, viewer limits, bot resistance and cost limits |
| Phone state | A physical phone retains application state | Dedicated demo accounts and verified cleanup between visitors |

## What an unrestricted shared link exposes

- Privacy: visitors can see whatever appears on the phone, including notifications, chat history, contacts and data from logged-in applications. A later visitor can inherit the previous visitor's screen and data.
- Account abuse: logged-in messaging or social apps may be used for impersonation, spam, account changes or unauthorized posts. Purchases and destructive settings are a risk wherever the phone permits them.
- Conflicting control: two visitors can change each other's screen between observation and action. A per-command motor lock does not isolate a whole user session.
- Copied credentials: a URL or access code can be forwarded, scripted or extracted from browser traffic. Origin checks do not replace authorization; authenticated non-browser clients can omit Origin.
- Availability and cost: automated clients can consume streams, requests, model budget if you provide an agent, and mechanical duty cycles. A shared grant also shares its rate budget.
- Infrastructure exposure: a freely controlled phone browser may reach services on its Wi-Fi network. Keep a public demo phone on an isolated network with no access to operator dashboards or other private systems.

These are risks of the access being granted, not proof of an exploit in the gateway. Existing hardware checks and blocked customer mechanical Home reduce specific risks; they do not make unrestricted application access safe. See [security responsibilities](/docs/security) and the [OWASP API Security risks](https://api-security.owasp.org/editions/2023/en/0x11-t10/).

## Recommended website experience

Start with a dedicated, cleaned demo phone and a controlled Try PhoneUse entry point. Use an isolated full-screen demo app with fictional data. Keep the existing customer phone and real WhatsApp conversations private. An initial public experience can offer a few bounded demo actions; provide unrestricted API/MCP access only after onboarding to a private assigned trial.

```text
Public website
  → server-validated bot check and visitor session
  → wait queue with clear availability
  → exclusive, time-limited control of a dedicated demo phone
  → server-enforced allowed actions and usage budget
  → revoke control, terminate the session stream and verify cleanup
  → offer a private API/MCP trial
```

A public Watch demo stream still needs a clean dedicated phone and a genuinely view-only server path. Do not embed a normal read-and-control customer key in a viewer page. Hiding buttons, a browser countdown, or a model instruction is not a server-side permission boundary.

If Cloudflare Turnstile is used for admission, validate its result on the server; a client-side widget alone does not protect session creation. Follow the [server-side validation guide](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

## Before enabling public control

- Remove real customer accounts, private photos, messages, credentials and payment methods. Apply OS-level app restrictions and isolate the phone network.
- Enforce exclusive ownership across browser, REST, MCP and background agents. Pause the WhatsApp assistant, recorder and operator workflows on the demo device while a visitor owns it.
- Enforce visitor expiry, action budgets and allowed operations at the gateway. Verify that direct API requests, copied credentials and stale WebSockets cannot bypass these controls.
- Test two simultaneous visitors, replay of an expired session, reconnection, idle timeout, device disconnection, physical Hold and immediate revocation.
- Verify reset and data cleanup before admitting the next visitor. If reset or HD Mirror fails, take the device out of the queue rather than assigning a broken trial.
- Provide an operator kill switch and sanitized logs. Record session ownership, action receipt IDs and failure categories without recording live keys or unrelated private content.

## Roll out and measure

Validate with invited testers first, then admit a small public cohort to the isolated demo. Measure trial starts, queue abandonment, time to first successful action, completion rate, errors and conversion to a private trial. Compare the conversion result with a control group; do not assume public access increases conversion.

Size capacity before advertising a live demo. For example, a proposed two-minute session plus a thirty-second verified reset allows at most 24 sessions per hour per phone before failures or idle gaps. This is a planning calculation, not measured station throughput. Prefer an honest queue or recorded demonstration when capacity is unavailable.
