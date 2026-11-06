import assert from "node:assert/strict";
import test from "node:test";
import { deviceAvailability } from "../app/device-availability";

function device(reason = "", available = false) {
  return { connected: true, state: { grbl: { homed: true, state: "Idle" } }, capabilities: { actions: { tap: { available, reason } } } };
}
test("video loss explains automatic recovery without claiming control is available", () => {
  assert.equal(deviceAvailability(device("A fresh camera frame is required.")).label, "Reconnecting video");
  assert.equal(deviceAvailability(device("The wired screen does not match the physical phone. Touch is locked.")).label, "Reconnecting video");
  assert.equal(deviceAvailability(device("", true)).label, "Available");
});
test("hardware alarms remain visible and customer setup stays with the operator", () => {
  const d = device(); d.state.grbl.state = "Alarm";
  assert.equal(deviceAvailability(d).label, "Needs attention");
  assert.equal(deviceAvailability(device("A verified calibration is required.")).label, "Setup required");
  assert.equal(deviceAvailability(device("A verified calibration is required."), true).label, "Preparing device");
  assert.doesNotMatch(deviceAvailability(device("Safety window locked")).detail, /locked/i);
});

test('a camera on standby is distinct from a broken stream, including a cached ready state', () => {
  const idle = { ...device('', true), state: { ...device().state, videoCapture: { scheduled: false } } };
  assert.equal(deviceAvailability(idle).label, 'Video standby');
  assert.match(deviceAvailability(idle).detail, /Start live video/);
  assert.match(deviceAvailability(idle, true).detail, /operator/);
});
