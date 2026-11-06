import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createRentalLease,
  createRentalLeaseToken,
  createRentalShortCode,
  monthlyLeaseEnd,
  renewRentalLease,
  revokeRentalLease,
  verifyRentalLeaseToken,
  type RentalLeaseRegistry,
} from "../shared/rental-leases.mjs";

const secret = "rental-test-secret-that-is-longer-than-32-characters";
const start = new Date("2026-01-31T12:30:00.000Z");
const empty: RentalLeaseRegistry = { version: 1, leases: [] };

test("uses calendar-month rental periods and clips short months", () => {
  assert.equal(
    monthlyLeaseEnd(start, 1).toISOString(),
    "2026-02-28T12:30:00.000Z",
  );
});

test("creates one active device lease and verifies its signed token", () => {
  const created = createRentalLease(empty, {
    deviceId: "black-arm-01",
    customer: "friend@example.com",
    months: 1,
  }, start);
  const token = createRentalLeaseToken(created.lease, secret);
  assert.match(token, /^pb_lease_v2\./);
  assert.equal(
    verifyRentalLeaseToken(
      token,
      secret,
      created.registry,
      new Date("2026-02-01T00:00:00.000Z"),
    ).deviceId,
    "black-arm-01",
  );
  assert.throws(() => createRentalLease(created.registry, {
    deviceId: "black-arm-01",
    customer: "another@example.com",
  }, new Date("2026-02-01T00:00:00.000Z")), /already has an active/);
});

test("revocation is immediate and renewal keeps the same valid token", () => {
  const created = createRentalLease(empty, {
    deviceId: "black-arm-01",
    customer: "friend@example.com",
  }, start);
  const oldToken = createRentalLeaseToken(created.lease, secret);
  const renewed = renewRentalLease(
    created.registry,
    created.lease.id,
    1,
    new Date("2026-02-01T00:00:00.000Z"),
  );
  const renewedToken = createRentalLeaseToken(renewed.lease, secret);
  assert.equal(renewed.lease.expiresAt, "2026-03-28T12:30:00.000Z");
  assert.equal(renewedToken, oldToken);
  assert.equal(verifyRentalLeaseToken(
    oldToken,
    secret,
    renewed.registry,
    new Date("2026-03-01T00:00:00.000Z"),
  ).id, created.lease.id);
  assert.equal(verifyRentalLeaseToken(
    renewedToken,
    secret,
    renewed.registry,
    new Date("2026-03-01T00:00:00.000Z"),
  ).id, created.lease.id);

  const revoked = revokeRentalLease(
    renewed.registry,
    created.lease.id,
    new Date("2026-03-02T00:00:00.000Z"),
  );
  assert.throws(() => verifyRentalLeaseToken(
    renewedToken,
    secret,
    revoked.registry,
    new Date("2026-03-03T00:00:00.000Z"),
  ), /revoked/);
});

test("accepts an unexpired legacy token during the fixed-code migration", () => {
  const created = createRentalLease(empty, {
    deviceId: "black-arm-01",
    customer: "friend@example.com",
  }, start);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    l: created.lease.id,
    e: Date.parse(created.lease.expiresAt),
  })).toString("base64url");
  const legacyToken = `pb_lease_v1.${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  assert.equal(verifyRentalLeaseToken(
    legacyToken,
    secret,
    created.registry,
    new Date("2026-02-01T00:00:00.000Z"),
  ).id, created.lease.id);
});

test("multi-device grants preserve legacy keys and reject overlapping assignments", () => {
  const created = createRentalLease(empty, {
    deviceIds: ["arm-a", "arm-b"], customer: "Acme engineering",
  }, start);
  assert.equal(created.registry.version, 2);
  assert.deepEqual(created.lease.deviceIds, ["arm-a", "arm-b"]);
  const token = createRentalLeaseToken(created.lease, secret);
  assert.deepEqual(verifyRentalLeaseToken(token, secret, created.registry, start).deviceIds, ["arm-a", "arm-b"]);
  assert.throws(() => createRentalLease(created.registry, { deviceId: "arm-b", customer: "Other" }, start), /already has an active/);
  assert.throws(() => createRentalLease(empty, { deviceIds: ["arm-a", "arm-a"], customer: "Acme" }, start), /unique/);
  assert.throws(() => createRentalLease(empty, { deviceIds: [], customer: "Acme" }, start), /between/);
  assert.throws(() => createRentalLease(empty, { deviceId: "arm-z", deviceIds: ["arm-a"], customer: "Acme" }, start), /primary/);
});

test("expired grants cannot reclaim a device allocated to another customer", () => {
  const first = createRentalLease(empty, { deviceIds: ["arm-a", "arm-b"], customer: "First" }, start);
  const later = new Date("2026-03-01T00:00:00Z");
  const second = createRentalLease(first.registry, { deviceId: "arm-b", customer: "Second" }, later);
  assert.throws(() => renewRentalLease(second.registry, first.lease.id, 1, later), /already has an active/);
});


test("short codes retain lease scope, renewal, expiry and revocation without registry changes", () => {
  const created = createRentalLease(empty, { deviceIds: ["arm-a", "arm-b"], customer: "Short code customer" }, start);
  const before = JSON.stringify(created.registry);
  const code = createRentalShortCode(created.lease, secret);
  assert.match(code, /^PB-(?:[2-9A-HJ-NP-Z]{4}-){3}[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(code.length, 22);
  assert.equal(JSON.stringify(created.registry), before);
  assert.deepEqual(verifyRentalLeaseToken(code.toLowerCase().replaceAll("-", " "), secret, created.registry, start).deviceIds, ["arm-a", "arm-b"]);
  assert.throws(() => verifyRentalLeaseToken(code, "different-signing-secret-at-least-32-characters", created.registry, start));
  const changed = code.slice(0, -1) + (code.endsWith("2") ? "3" : "2");
  assert.throws(() => verifyRentalLeaseToken(changed, secret, created.registry, start));
  assert.throws(() => verifyRentalLeaseToken(code, secret, empty, start));
  assert.throws(() => verifyRentalLeaseToken(code, secret, created.registry, new Date(created.lease.expiresAt)));
  const renewed = renewRentalLease(created.registry, created.lease.id, 1, start);
  assert.equal(createRentalShortCode(renewed.lease, secret), code);
  assert.equal(verifyRentalLeaseToken(code, secret, renewed.registry, new Date(created.lease.expiresAt)).id, created.lease.id);
  const revoked = revokeRentalLease(renewed.registry, created.lease.id, start);
  assert.throws(() => verifyRentalLeaseToken(code, secret, revoked.registry, start));
});
