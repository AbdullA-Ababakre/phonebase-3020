type Point = { x: number; y: number };
type RecordValue = Record<string, unknown>;

export class ManualCalibrationError extends Error {
  constructor(message: string, readonly code: string, readonly status = 409) {
    super(message);
    this.name = "ManualCalibrationError";
  }
}

export function calibrationRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : {};
}

export function assertCalibrationStatus(grbl: RecordValue, updatedAt: number, now = Date.now()) {
  if (!Number.isFinite(updatedAt) || now - updatedAt > 6_000 || updatedAt > now + 1_000) {
    throw new ManualCalibrationError("The controller status is stale. Wait for a fresh hardware status before calibrating.", "DEVICE_STATUS_STALE");
  }
  if (grbl.connected !== true) {
    throw new ManualCalibrationError("The CH340/GRBL hardware link must be online.", "HARDWARE_OFFLINE");
  }
  if (grbl.homed !== true) {
    throw new ManualCalibrationError("Machine homing must complete before moving or recording machine points. Return to device setup and home with the workspace clear.", "MACHINE_HOME_REQUIRED");
  }
  if (Object.keys(calibrationRecord(grbl.activeOperation)).length) {
    throw new ManualCalibrationError("Wait for the current physical operation to finish before calibrating.", "DEVICE_BUSY");
  }
  if (grbl.state !== "Idle") {
    throw new ManualCalibrationError(`The controller must be Idle before calibrating; current state: ${String(grbl.state ?? "unknown")}.`, "CONTROLLER_NOT_IDLE");
  }
  if (grbl.calibrationActive !== true) {
    throw new ManualCalibrationError("Enable the local calibration window on the hardware node first.", "LOCAL_UNLOCK_REQUIRED");
  }
  const z = grbl.z;
  if (typeof z !== "number" || !Number.isFinite(z) || Math.abs(z) > 0.02) {
    throw new ManualCalibrationError("The stylus must be at the verified hover height (displayed Z=0) before moving or recording calibration points.", "HOVER_REQUIRED");
  }
  if (![grbl.x, grbl.y].every(value => typeof value === "number" && Number.isFinite(value))) {
    throw new ManualCalibrationError("A valid controller XY position is required before calibrating.", "INVALID_CONTROLLER_POSITION");
  }
}

export function assertCalibrationFrame(
  frame: { width: number; height: number; capturedAt: number } | null,
  draftFrame?: { width: number; height: number }, now = Date.now(),
) {
  if (!frame || !Number.isFinite(frame.capturedAt) || now - frame.capturedAt > 2_500 || frame.capturedAt > now + 1_000) {
    throw new ManualCalibrationError("A fresh physical camera frame is required. Wait for live video before recording calibration points.", "FRAME_UNAVAILABLE");
  }
  if (draftFrame && (frame.width !== draftFrame.width || frame.height !== draftFrame.height)) {
    throw new ManualCalibrationError("The camera dimensions changed during calibration. Start a new calibration before recording more points.", "CALIBRATION_FRAME_CHANGED");
  }
}

export function assertMachinePointCapture(
  draft: { imagePoints: Array<Point | null>; machinePoints: Array<Point | null> },
  index: number, position: Point,
) {
  if (!draft.imagePoints[index]) {
    throw new ManualCalibrationError(`Select the visible camera corner ${index + 1} before recording its matching machine position.`, "CAMERA_POINT_REQUIRED");
  }
  const duplicate = draft.machinePoints.findIndex((point, other) =>
    other !== index && point !== null && Math.hypot(point.x - position.x, point.y - position.y) < 5,
  );
  if (duplicate !== -1) {
    throw new ManualCalibrationError(`This XY position overlaps recorded corner ${duplicate + 1}. Move the hovering stylus to corner ${index + 1} before capturing XY; selecting a camera corner does not move the arm. Restart calibration to clear old incorrect captures.`, "DUPLICATE_MACHINE_POINT");
  }
}

export type CalibrationJogNode = { grbl: RecordValue; updatedAt: number };

/** Observe the exact dispatched operation once. This function never sends or retries motion. */
export async function waitForCalibrationJog(input: {
  id: string;
  target: Point;
  readNode: () => CalibrationJogNode | null;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}) {
  const now = input.now ?? Date.now;
  const delay = input.delay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (input.timeoutMs ?? 10_000);
  while (now() < deadline) {
    const node = input.readNode();
    if (!node || !Number.isFinite(node.updatedAt) || now() - node.updatedAt > 6_000 || node.updatedAt > now() + 1_000) {
      throw new ManualCalibrationError(`Calibration move ${input.id} lost fresh controller confirmation. Do not resend it; inspect the device and wait for its final status.`, "CALIBRATION_JOG_UNCONFIRMED");
    }
    const operation = calibrationRecord(node.grbl.lastOperation);
    if (operation.id === input.id) {
      if (operation.status === "failed") {
        throw new ManualCalibrationError(`Calibration move failed: ${String(operation.error ?? "The controller rejected the move.")}`, "CALIBRATION_JOG_FAILED");
      }
      if (operation.status === "completed") {
        assertCalibrationStatus(node.grbl, node.updatedAt, now());
        const x = Number(node.grbl.x), y = Number(node.grbl.y);
        if (Math.abs(x - input.target.x) > 0.15 || Math.abs(y - input.target.y) > 0.15) {
          throw new ManualCalibrationError(`Calibration move ${input.id} finished without confirming the requested XY. Inspect the position before another move.`, "CALIBRATION_JOG_POSITION_MISMATCH");
        }
        return { id: input.id, status: "completed" as const };
      }
    }
    await delay(50);
  }
  throw new ManualCalibrationError(`Calibration move ${input.id} has no final controller confirmation. Do not resend it; wait for the device status and inspect the workspace.`, "CALIBRATION_JOG_UNCONFIRMED");
}
