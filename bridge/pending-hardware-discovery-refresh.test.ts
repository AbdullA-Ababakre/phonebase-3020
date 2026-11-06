import assert from "node:assert/strict";
import test from "node:test";
import { PendingHardwareDiscoveryRefresh } from "./pending-hardware-discovery-refresh.ts";
import { nextFleetDeviceId, pairUsbHardware } from "./fleet_enrollment.ts";

// Replay the observed ordering: ioreg + serial are ready before AVFoundation.
// All discovery data and enrollment writes here are in-memory; no USB, process,
// configuration, controller, or motion APIs are imported.
function fixture() {
  const refresh = new PendingHardwareDiscoveryRefresh();
  const configured = Array.from({ length: 12 }, (_, i) => `sf-black-arm-${String(i + 1).padStart(2, "0")}`);
  const originalIds = [...configured];
  const controller = { serial: "/dev/cu.usbserial-120", location: "00120000" };
  const camera = { identity: "0x1100000bda5858", location: "00110000" };
  const state = { avReady: false, serialReady: true, discoveries: 0, enrolled: [] as { id: string; camera: string }[] };
  function tick(now: number, signature = "six-usb-cameras-six-serials") {
    if (!refresh.shouldRefresh(signature, now)) return;
    state.discoveries++;
    const serials = state.serialReady && !state.enrolled.length ? [controller] : [];
    const cameras = state.avReady && !state.enrolled.length ? [camera] : [];
    const pairs = pairUsbHardware(serials, cameras);
    const pending = serials.length !== cameras.length || pairs.length !== serials.length;
    if (!pending) for (const pair of pairs) {
      const id = nextFleetDeviceId(configured, "sf-black-arm");
      configured.push(id);
      state.enrolled.push({ id, camera: pair.camera.identity });
    }
    refresh.settled(signature, pending, now);
  }
  return { state, tick, configured, originalIds };
}

test("a delayed AVFoundation camera is retried despite an unchanged USB signature", () => {
  const f = fixture();
  f.tick(0);
  assert.equal(f.state.enrolled.length, 0);
  f.state.avReady = true;
  f.tick(4_999);
  assert.equal(f.state.discoveries, 1);
  f.tick(5_000);
  assert.deepEqual(f.state.enrolled, [{ id: "sf-black-arm-13", camera: "0x1100000bda5858" }]);
  assert.deepEqual(f.configured.slice(0, 12), f.originalIds, "old IDs must not be reassigned to moved hardware");
});

test("completed discovery waits 30 seconds before a periodic observation refresh", () => {
  const f = fixture();
  f.state.avReady = true;
  f.tick(0);
  f.tick(5_000);
  f.tick(29_999);
  assert.equal(f.state.discoveries, 1);
  f.tick(30_000);
  assert.equal(f.state.discoveries, 2);
  assert.equal(f.state.enrolled.length, 1);
});

test("a new USB signature is reconsidered immediately before a pending retry is due", () => {
  const f = fixture();
  f.tick(0);
  f.state.avReady = true;
  f.tick(1_000, "new-hardware-signature");
  assert.equal(f.state.discoveries, 2);
  assert.equal(f.state.enrolled.length, 1);
});

test("retry does not bypass the complete-pair gate or modify existing station IDs", () => {
  const f = fixture();
  f.tick(0);
  f.tick(5_000);
  f.tick(10_000);
  assert.equal(f.state.discoveries, 3);
  assert.deepEqual(f.state.enrolled, []);
  assert.deepEqual(f.configured, f.originalIds);
});

test("removing an incomplete pair clears the pending retry", () => {
  const f = fixture();
  f.tick(0);
  f.state.serialReady = false;
  f.tick(5_000, "unplugged-signature");
  f.tick(10_000, "unplugged-signature");
  assert.equal(f.state.discoveries, 2);
  assert.deepEqual(f.state.enrolled, []);
});


test("a signature changed during observation remains due on the next poll", () => {
  const refresh = new PendingHardwareDiscoveryRefresh();
  const sampledBeforeObservation = "old-usb-state";
  refresh.settled(sampledBeforeObservation, false, 100);
  assert.equal(refresh.shouldRefresh("new-usb-state", 101), true);
});
