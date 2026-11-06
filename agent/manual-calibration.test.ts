import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCalibrationFrame, assertCalibrationStatus, assertMachinePointCapture,
  ManualCalibrationError, waitForCalibrationJog,
} from "./manual-calibration";

const idle = () => ({
  connected: true, homed: true, state: "Idle", calibrationActive: true,
  x: 1, y: 2, z: 0, activeOperation: null, lastOperation: {},
});
const code = (expected: string) => (error: unknown) =>
  error instanceof ManualCalibrationError && error.code === expected;

test("manual calibration requires fresh, homed, idle hardware at normalized hover", () => {
  assert.doesNotThrow(() => assertCalibrationStatus(idle(), 1_000, 1_000));
  for (const [patch, expected] of [
    [{ homed: false }, "MACHINE_HOME_REQUIRED"],
    [{ state: "Hold:0" }, "CONTROLLER_NOT_IDLE"],
    [{ activeOperation: { id: "other", type: "tap" } }, "DEVICE_BUSY"],
    [{ z: 1 }, "HOVER_REQUIRED"],
    [{ z: null }, "HOVER_REQUIRED"],
    [{ x: null }, "INVALID_CONTROLLER_POSITION"],
    [{ calibrationActive: false }, "LOCAL_UNLOCK_REQUIRED"],
    [{ connected: false }, "HARDWARE_OFFLINE"],
  ] as const) {
    assert.throws(() => assertCalibrationStatus({ ...idle(), ...patch }, 1_000, 1_000), code(expected));
  }
  assert.throws(() => assertCalibrationStatus(idle(), 1_000, 7_001), code("DEVICE_STATUS_STALE"));
});

test("camera-point capture rejects stale, absent, future, and resized frames", () => {
  const frame = { width: 720, height: 1280, capturedAt: 1_000 };
  assert.doesNotThrow(() => assertCalibrationFrame(frame, frame, 1_000));
  assert.throws(() => assertCalibrationFrame(null, frame, 1_000), code("FRAME_UNAVAILABLE"));
  assert.throws(() => assertCalibrationFrame(frame, frame, 3_501), code("FRAME_UNAVAILABLE"));
  assert.throws(() => assertCalibrationFrame({ ...frame, capturedAt: 4_000 }, frame, 1_000), code("FRAME_UNAVAILABLE"));
  assert.throws(() => assertCalibrationFrame(frame, { width: 1280, height: 720 }, 1_000), code("CALIBRATION_FRAME_CHANGED"));
});

test("machine captures require the matching image corner and reject unchanged XY", () => {
  const draft = { imagePoints: [{ x: 100, y: 100 }, null, null, null], machinePoints: [{ x: 1, y: 2 }, null, null, null] };
  assert.throws(() => assertMachinePointCapture(draft, 1, { x: 50, y: 2 }), code("CAMERA_POINT_REQUIRED"));
  draft.imagePoints[1] = { x: 600, y: 100 };
  assert.throws(() => assertMachinePointCapture(draft, 1, { x: 1.2, y: 2 }), code("DUPLICATE_MACHINE_POINT"));
  assert.doesNotThrow(() => assertMachinePointCapture(draft, 1, { x: 60, y: 2 }));
  assert.doesNotThrow(() => assertMachinePointCapture(draft, 0, { x: 1, y: 2 }));
});

test("jog waits for its exact final operation, not acceptance or another command", async () => {
  let time = 1_000;
  let polls = 0;
  const state = idle();
  const result = await waitForCalibrationJog({
    id: "requested", target: { x: 3, y: 2 }, now: () => time,
    readNode: () => ({ grbl: state, updatedAt: time }),
    delay: async ms => {
      time += ms; polls++;
      if (polls === 1) state.lastOperation = { id: "unrelated", status: "completed" };
      if (polls === 2) state.lastOperation = { id: "requested", status: "executing" };
      if (polls === 3) { state.x = 3; state.lastOperation = { id: "requested", status: "completed" }; }
    },
  });
  assert.deepEqual(result, { id: "requested", status: "completed" });
  assert.equal(polls, 3);
});

test("driver rejection is surfaced with its real reason", async () => {
  const state = { ...idle(), lastOperation: { id: "requested", status: "failed", error: "Arm homing alarm: Alarm" } };
  await assert.rejects(waitForCalibrationJog({
    id: "requested", target: { x: 3, y: 2 }, now: () => 1_000,
    readNode: () => ({ grbl: state, updatedAt: 1_000 }),
  }), error => code("CALIBRATION_JOG_FAILED")(error) && (error as Error).message.includes("Arm homing alarm: Alarm"));
});

test("missing final status times out without resending a command", async () => {
  let time = 1_000;
  let polls = 0;
  await assert.rejects(waitForCalibrationJog({
    id: "requested", target: { x: 3, y: 2 }, now: () => time, timeoutMs: 100,
    readNode: () => { polls++; return { grbl: idle(), updatedAt: time }; },
    delay: async ms => { time += ms; },
  }), code("CALIBRATION_JOG_UNCONFIRMED"));
  assert.equal(polls, 2);
});

test("disconnect or stale status leaves a jog unconfirmed", async () => {
  for (const readNode of [() => null, () => ({ grbl: idle(), updatedAt: 0 })]) {
    await assert.rejects(waitForCalibrationJog({
      id: "requested", target: { x: 3, y: 2 }, now: () => 10_000, readNode,
    }), code("CALIBRATION_JOG_UNCONFIRMED"));
  }
});

test("a completed jog must confirm the requested settled position", async () => {
  await assert.rejects(waitForCalibrationJog({
    id: "requested", target: { x: 3, y: 2 }, now: () => 1_000,
    readNode: () => ({ grbl: { ...idle(), lastOperation: { id: "requested", status: "completed" } }, updatedAt: 1_000 }),
  }), code("CALIBRATION_JOG_POSITION_MISMATCH"));
});
