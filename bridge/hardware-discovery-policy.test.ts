import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendDiscoveredFleetDevices, updateFleetConfigurationSync } from "./fleet-configuration-store";
import { fleetDiscoverySnapshot } from "./fleet-discovery-snapshot";
import { hardwareDiscoveryPolicy, withAutomaticHardwareEnrollment } from "./hardware-discovery-policy";

test("automatic enrollment defaults on for existing configurations but rejects malformed explicit policy", () => {
  assert.equal(hardwareDiscoveryPolicy({}).automaticEnrollment, true);
  assert.equal(hardwareDiscoveryPolicy({ hardwareDiscovery: {} }).automaticEnrollment, true);
  assert.equal(hardwareDiscoveryPolicy({ hardwareDiscovery: { automaticEnrollment: false } }).automaticEnrollment, false);
  for (const value of [null, false, [], "false", { automaticEnrollment: "false" }, { automaticEnrollment: 0 }]) {
    assert.throws(() => hardwareDiscoveryPolicy({ hardwareDiscovery: value }), /Invalid/);
  }
});

test("paused enrollment preserves bindings and file bytes, exposes unclaimed components, and can resume", () => {
  const directory = mkdtempSync(join(tmpdir(), "phoneuse-enrollment-policy-"));
  const path = join(directory, "fleet.json");
  const bindings = [{ id: "arm-01", serial: "/dev/cu.usbserial-old", cameraIdentity: "camera-old", profileId: "verified-old" }];
  const candidate = { id: "arm-02", serial: "/dev/cu.usbserial-120", cameraIdentity: "0x1100000bda5858", profileId: "unconfigured" };
  const configuration = { devices: bindings, hardwareDiscovery: { automaticEnrollment: false } };
  let enrollmentCalls = 0;
  const enroll = () => {
    enrollmentCalls++;
    updateFleetConfigurationSync(path, current => appendDiscoveredFleetDevices<{ id: string }>(current, bindings, current.devices, [candidate]));
    return [...bindings, candidate];
  };
  try {
    writeFileSync(path, JSON.stringify(configuration));
    const before = readFileSync(path, "utf8");
    const paused = withAutomaticHardwareEnrollment(hardwareDiscoveryPolicy(configuration), bindings, enroll);
    assert.equal(paused.paused, true);
    assert.equal(paused.bindings, bindings);
    assert.equal(enrollmentCalls, 0, "paused discovery must not allocate/persist/start new hardware");
    assert.equal(readFileSync(path, "utf8"), before);
    const snapshot = fleetDiscoverySnapshot(bindings, { observedAt: 1, serials: [candidate.serial], cameras: [{ index: "0", name: "USB Camera2", uniqueId: candidate.cameraIdentity }] }, new Map(), true, 2, false);
    assert.equal(snapshot.automaticEnrollment, false);
    assert.equal(snapshot.discoveryPending, true);
    assert.deepEqual(snapshot.unclaimed.controllers, [candidate.serial]);
    assert.deepEqual(snapshot.unclaimed.cameras.map(camera => camera.identity), [candidate.cameraIdentity]);
    updateFleetConfigurationSync(path, current => ({ ...current, hardwareDiscovery: { automaticEnrollment: true } }));
    const latest = JSON.parse(readFileSync(path, "utf8"));
    const resumed = withAutomaticHardwareEnrollment(hardwareDiscoveryPolicy(latest), bindings, enroll);
    assert.equal(resumed.paused, false);
    assert.equal(enrollmentCalls, 1);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).devices, [...bindings, candidate]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the locked append rechecks a pause made after the initial discovery snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "phoneuse-enrollment-race-"));
  const path = join(directory, "fleet.json");
  const bindings = [{ id: "arm-01" }];
  try {
    writeFileSync(path, JSON.stringify({ devices: bindings, hardwareDiscovery: { automaticEnrollment: false } }));
    assert.throws(() => updateFleetConfigurationSync(path, current => appendDiscoveredFleetDevices(current, bindings, current.devices, [{ id: "arm-02" }])), /enrollment was paused/);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).devices, bindings);
    assert.throws(() => updateFleetConfigurationSync(path, current => ({ ...current, hardwareDiscovery: { automaticEnrollment: "false" } })), /Invalid automatic/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).hardwareDiscovery.automaticEnrollment, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("focus-style settings updates retain an explicit enrollment pause", () => {
  const directory = mkdtempSync(join(tmpdir(), "phoneuse-enrollment-focus-"));
  const path = join(directory, "fleet.json");
  try {
    writeFileSync(path, JSON.stringify({ devices: [{ id: "arm-01" }], hardwareDiscovery: { automaticEnrollment: false } }));
    updateFleetConfigurationSync(path, current => ({ ...current, videoCapture: { focusDeviceId: "arm-01" } }));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).hardwareDiscovery.automaticEnrollment, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
