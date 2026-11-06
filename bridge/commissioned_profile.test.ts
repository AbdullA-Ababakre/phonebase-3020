import assert from "node:assert/strict";
import test from "node:test";
import { refreshCommissionedTapProfile, validateCommissionedTapProfile } from "./commissioned_profile";

const policy = { deviceId: "sf-black-arm-10", configuredProfileId: "unconfigured", hoverZ: 1, minimumTouchZ: 9.5, maximumTouchZ: 10 };

function input() {
  return {
    id: "phonebase-sf-black-arm-10-physical-v1", deviceId: policy.deviceId,
    verified: true, verifiedAt: "2026-11-03T20:00:00Z",
    frame: { width: 720, height: 1280 }, screen: { width: 720, height: 1280 },
    imagePoints: [{ x: 0, y: 0 }, { x: 720, y: 0 }, { x: 720, y: 1280 }, { x: 0, y: 1280 }],
    machinePoints: [{ x: 6, y: 11 }, { x: 78, y: 11 }, { x: 78, y: 168 }, { x: 6, y: 168 }],
    safeMachineBounds: { minimumX: 6, maximumX: 78, minimumY: 11, maximumY: 168 },
    tap: { hoverZ: 1, touchZ: 10, normalTouchZ: 9.5, zStep: 0.5, feed: 3000, dwellMs: 40 },
  };
}

test("commissioning an unconfigured fleet node accepts only its exact device and allowed profile ID", () => {
  const profile = validateCommissionedTapProfile(input(), policy);
  assert.equal(profile?.id, input().id);
  assert.equal(profile?.normalTouchZ, 9.5);
  assert.equal(validateCommissionedTapProfile({ ...input(), deviceId: "sf-black-arm-06" }, policy), null);
  for (const id of ["unconfigured", "placeholder", "default", "phonebase-sf-black-arm-06-physical-v1", "unexpected"]) {
    assert.equal(validateCommissionedTapProfile({ ...input(), id }, policy), null);
  }
  assert.equal(validateCommissionedTapProfile({ ...input(), id: "existing-custom-id" }, { ...policy, configuredProfileId: "existing-custom-id" })?.id, "existing-custom-id");
});

test("commissioned values cannot change the node's hover or expand either touch limit", () => {
  for (const tap of [
    { ...input().tap, hoverZ: 2 }, { ...input().tap, touchZ: 10.1 },
    { ...input().tap, touchZ: 9.4, normalTouchZ: 9.4 },
    { ...input().tap, normalTouchZ: 9.4 }, { ...input().tap, normalTouchZ: 10.1 },
  ]) assert.equal(validateCommissionedTapProfile({ ...input(), tap }, policy), null);
  assert.equal(validateCommissionedTapProfile(input(), { ...policy, maximumTouchZ: Number.NaN }), null);
});

test("malformed, unverified, undated and degenerate calibration files stay locked", () => {
  for (const value of [null, {}, { ...input(), verified: false }, { ...input(), verifiedAt: "not-a-date" },
    { ...input(), machinePoints: Array(4).fill({ x: 6, y: 11 }) }]) {
    assert.equal(validateCommissionedTapProfile(value, policy), null);
  }
});

test("initial adoption and changed pressures wait for an idle operation boundary", () => {
  const candidate = validateCommissionedTapProfile(input(), policy)!;
  const initial = { current: null, currentReady: false, latestVerifiedAt: Number.NEGATIVE_INFINITY, candidate };
  const pending = refreshCommissionedTapProfile({ ...initial, canAdopt: false });
  assert.equal(pending.ready, false);
  assert.equal(pending.profile, null);
  const adopted = refreshCommissionedTapProfile({ ...initial, canAdopt: true });
  assert.equal(adopted.ready, true);
  const changed = { ...candidate, verifiedAt: candidate.verifiedAt + 1000, touchZ: 9.75 };
  const busy = refreshCommissionedTapProfile({ current: adopted.profile, currentReady: true, latestVerifiedAt: adopted.latestVerifiedAt, candidate: changed, canAdopt: false });
  assert.equal(busy.ready, false);
  assert.equal(busy.profile?.touchZ, 10);
  const idle = refreshCommissionedTapProfile({ current: busy.profile, currentReady: busy.ready, latestVerifiedAt: busy.latestVerifiedAt, candidate: changed, canAdopt: true });
  assert.equal(idle.profile?.touchZ, 9.75);
  assert.equal(idle.ready, true);
});

test("valid to malformed/deleted to valid revokes readiness without changing in-flight parameters", () => {
  const candidate = validateCommissionedTapProfile(input(), policy)!;
  const invalid = refreshCommissionedTapProfile({ current: candidate, currentReady: true, latestVerifiedAt: candidate.verifiedAt, candidate: null, canAdopt: false });
  assert.equal(invalid.ready, false);
  assert.equal(invalid.profile?.touchZ, 10);
  const restoredWhileBusy = refreshCommissionedTapProfile({ current: invalid.profile, currentReady: invalid.ready, latestVerifiedAt: invalid.latestVerifiedAt, candidate, canAdopt: false });
  assert.equal(restoredWhileBusy.ready, false);
  const restored = refreshCommissionedTapProfile({ current: invalid.profile, currentReady: invalid.ready, latestVerifiedAt: invalid.latestVerifiedAt, candidate, canAdopt: true });
  assert.equal(restored.ready, true);
  assert.equal(refreshCommissionedTapProfile({ current: candidate, currentReady: true, latestVerifiedAt: candidate.verifiedAt, candidate, canAdopt: false }).ready, true);
});

test("an older verified file cannot roll back an adopted calibration", () => {
  const candidate = validateCommissionedTapProfile(input(), policy)!;
  const previous = { ...candidate, verifiedAt: candidate.verifiedAt + 1000, touchZ: 9.75 };
  const rollback = refreshCommissionedTapProfile({ current: previous, currentReady: true, latestVerifiedAt: previous.verifiedAt, candidate, canAdopt: true });
  assert.equal(rollback.ready, false);
  assert.equal(rollback.profile?.touchZ, 9.75);
  assert.equal(rollback.latestVerifiedAt, previous.verifiedAt);
});
