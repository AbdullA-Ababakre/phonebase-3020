import assert from "node:assert/strict";
import test from "node:test";
import { fleetDiscoveryView, readFleetDiscoveryView } from "./fleet-discovery-status";

const report = () => ({ version: 1, observedAt: 100_000, publishedAt: 100_000, discoveryPending: true,
  configured: [{ id: "stand-01", controllerPresent: true, cameraResolved: true, reason: null },
    { id: "stand-02", controllerPresent: false, cameraResolved: false, reason: "Controller and camera absent" }],
  unclaimed: { controllers: ["/dev/cu.usbserial-120"], cameras: [{ identity: "0x1100000bda5858", name: "USB Camera2" }] } });

test("discovery never invents online or live-video state for an unresolved station", () => {
  const result = fleetDiscoveryView(report(), [{ id: "stand-01", connected: true, liveVideo: false }], 100_001);
  assert.equal(result.available, true);
  assert.equal(result.configured.length, 2);
  assert.equal(result.configured[0].nodeConnected, true);
  assert.equal(result.configured[0].liveVideo, false);
  assert.equal(result.configured[1].nodeConnected, false);
  assert.equal(result.configured[1].liveVideo, false);
  assert.equal(result.unclaimed.controllers[0], "/dev/cu.usbserial-120");
});

test("old component observations are explicitly stale while live node state stays current", () => {
  const result = fleetDiscoveryView(report(), [{ id: "stand-01", connected: true, liveVideo: true }], 160_001);
  assert.equal(result.stale, true);
  assert.match(result.detail ?? "", /outdated/);
  assert.equal(result.configured[0].liveVideo, true);
});

test("malformed, duplicate and future identities fail closed without leaking extra fields", () => {
  for (const value of [null, { ...report(), observedAt: 200_000 },
    { ...report(), configured: [report().configured[0], report().configured[0]] },
    { ...report(), unclaimed: { controllers: ["/etc/passwd"], cameras: [] } }]) {
    const result = fleetDiscoveryView(value, [], 100_001);
    assert.equal(result.available, false);
    assert.deepEqual(result.configured, []);
  }
  const result = fleetDiscoveryView({ ...report(), secret: "must-not-be-returned" }, [], 100_001);
  assert.equal("secret" in result, false);
});

test("a missing discovery file remains distinguishable from absent hardware", () => {
  const result = readFleetDiscoveryView("/nonexistent-phoneuse-discovery/report.json", [], 100_001);
  assert.equal(result.available, false);
  assert.match(result.detail ?? "", /Waiting/);
});

test("paused enrollment stays explicit while existing live nodes remain available", () => {
  const result = fleetDiscoveryView({ ...report(), automaticEnrollment: false }, [{ id: "stand-01", connected: true, liveVideo: true }], 100_001);
  assert.equal(result.automaticEnrollment, false);
  assert.equal(result.configured[0].liveVideo, true);
  assert.equal(fleetDiscoveryView(report(), [], 100_001).automaticEnrollment, true);
  assert.equal(fleetDiscoveryView({ ...report(), automaticEnrollment: "false" }, [], 100_001).available, false);
});
