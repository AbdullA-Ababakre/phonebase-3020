import assert from "node:assert/strict";
import test from "node:test";
import { calibrationFrameIssue, calibrationJogIssue, calibrationMotionIssue, repeatedMachinePointIssue, type CalibrationController } from "../shared/calibration-workflow";

const ready: CalibrationController = { connected: true, homed: true, state: "Idle", calibrationActive: true, x: 1, y: 1, z: 0 };
test("calibration distinguishes Home, Hold, Alarm, active motion and hover requirements", () => {
  assert.equal(calibrationMotionIssue(ready), null);
  assert.match(calibrationMotionIssue({ ...ready, homed: false })!, /Home this machine/);
  assert.match(calibrationMotionIssue({ ...ready, state: "Hold:0" })!, /paused/);
  assert.match(calibrationMotionIssue({ ...ready, state: "Alarm" })!, /Alarm/);
  assert.match(calibrationMotionIssue({ ...ready, activeOperation: {} })!, /finish/);
  assert.match(calibrationMotionIssue({ ...ready, z: 4 })!, /hover/);
});
test("station at X=1 Y=1 can move positive while negative steps remain blocked", () => {
  for (const axis of ["X", "Y"] as const) {
    assert.equal(calibrationJogIssue(ready, axis, 2), null);
    assert.match(calibrationJogIssue(ready, axis, -0.5)!, /leave the calibration area/);
  }
  assert.equal(calibrationJogIssue({ ...ready, x: 81.5 }, "X", 0.5), null);
  assert.match(calibrationJogIssue({ ...ready, x: 81.5 }, "X", 2)!, /smaller step/);
  assert.match(calibrationJogIssue({ ...ready, calibrationMovementBounds: { maximumX: 1 } }, "X", 0.5)!, /leave/);
});
test("point recording requires current raw video for the selected device and draft dimensions", () => {
  const frame = { deviceId: "sf-black-arm-10", width: 1280, height: 720, capturedAt: 10_000, rectified: false };
  const check = (candidate: typeof frame | null, connected = true, now = 11_000, draft = { width: 1280, height: 720 }) => calibrationFrameIssue(candidate, "sf-black-arm-10", connected, now, draft);
  assert.equal(check(frame), null);
  assert.match(check(frame, false)!, /fresh/);
  assert.match(check(frame, true, 14_000)!, /stale/);
  assert.match(check({ ...frame, deviceId: "sf-black-arm-04" })!, /different device/);
  assert.match(check({ ...frame, rectified: true })!, /raw/);
  assert.match(check(frame, true, 11_000, { width: 640, height: 480 })!, /Restart/);
});
test("unchanged XY cannot masquerade as a second physical corner", () => {
  const points = [{ x: 1, y: 1 }, null, null, null];
  assert.match(repeatedMachinePointIssue(points, 1, 1.01, 1.01)!, /still at.*corner 1/);
  assert.equal(repeatedMachinePointIssue(points, 0, 1, 1), null);
  assert.equal(repeatedMachinePointIssue(points, 1, 70, 1), null);
});
