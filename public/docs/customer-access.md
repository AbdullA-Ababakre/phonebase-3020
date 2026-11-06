# Provision customer access

Assign devices, deliver a private invitation, and manage the trial lifecycle from your local Dashboard.

## Assign a customer

- Open the local Dashboard and select Customer access.
- Enter a company or customer label and select the connected, available devices for that customer.
- Select Create & copy access code. The short code is copied automatically. One key covers the assigned devices on this station.
- Send the short code privately, or select Copy invitation link so the customer can open their workspace without pasting a code.
- Give the customer the [remote quickstart](/docs/quickstart), and verify they can see only their assigned devices.

## Manage lifecycle

Renew access using Renew 1 month. Current v2 links remain unchanged. Revoke the grant to disable further access. Revoked grants cannot be renewed; create a new grant when new credentials are needed. A device with an active grant cannot be allocated to another customer.

Do not renew an expired grant if one of its devices has since been allocated to another customer. The platform rejects this overlapping assignment.

## Current administration boundary

This release manages customer grants on one local station. A company label is not an organization account, and one key shared by a team does not create individual member identities. For multi-station management, enterprise SSO, centralized audit export, or centralized policy, agree a separate implementation and acceptance plan.

Local administrators can export the currently displayed page of activity records from Activity & incidents. This is not a complete account-wide audit export. Events are retained for up to 30 days, subject to a 250,000-event cap; high-volume stations can reach that cap sooner.
