export type CalibrationController = {
  connected?: boolean;
  homed?: boolean;
  calibrationActive?: boolean;
  state?: string;
  x?: number;
  y?: number;
  z?: number;
  activeOperation?: unknown;
  calibrationMovementBounds?: {
    minimumX?: number; maximumX?: number; minimumY?: number; maximumY?: number;
  };
};

export function calibrationMotionIssue(controller?: CalibrationController): string | null {
  if (!controller?.connected) return "The hardware controller is disconnected.";
  if (!controller.homed) return "Home this machine from the Dashboard before moving the stylus.";
  if (controller.activeOperation) return "Wait for the current physical operation to finish.";
  if (controller.state?.startsWith("Hold")) return "Motion is paused. Resume only after checking the workspace is clear.";
  if (controller.state !== "Idle") return `The controller is ${controller.state || "unavailable"}. Calibration motion requires Idle.`;
  if (!controller.calibrationActive) return "Enable the local calibration window on this hardware node first.";
  if (!Number.isFinite(controller.z) || Math.abs(controller.z!) > 0.02) return "The stylus must be at hover Z=0 before calibration.";
  if (!Number.isFinite(controller.x) || !Number.isFinite(controller.y)) return "Waiting for the controller's current XY position.";
  return null;
}

export function calibrationJogIssue(controller: CalibrationController | undefined, axis: "X" | "Y", distance: number): string | null {
  const issue = calibrationMotionIssue(controller);
  if (issue) return issue;
  if (!Number.isFinite(distance) || distance === 0 || Math.abs(distance) > 10) return "Choose a calibration step from 0.5 to 10 mm.";
  const bounds = controller!.calibrationMovementBounds ?? {};
  const minimumX = bounds.minimumX ?? 1, maximumX = bounds.maximumX ?? 82;
  const minimumY = bounds.minimumY ?? 1, maximumY = bounds.maximumY ?? 170;
  const x = controller!.x! + (axis === "X" ? distance : 0);
  const y = controller!.y! + (axis === "Y" ? distance : 0);
  if (![minimumX, maximumX, minimumY, maximumY].every(Number.isFinite)) return "The calibration movement bounds are unavailable.";
  if (x < minimumX || x > maximumX || y < minimumY || y > maximumY) {
    return `This ${Math.abs(distance)} mm step would leave the calibration area (X ${minimumX}–${maximumX}, Y ${minimumY}–${maximumY} mm). Choose a smaller step or the opposite direction.`;
  }
  return null;
}

export function calibrationFrameIssue(
  frame: { deviceId?: string; width: number; height: number; capturedAt: number; rectified?: boolean } | null,
  deviceId: string, connected: boolean, now: number,
  draftFrame?: { width: number; height: number },
): string | null {
  if (!connected || !frame) return "Wait for a fresh physical camera frame.";
  if (frame.deviceId !== deviceId) return "The camera frame belongs to a different device.";
  if (frame.rectified) return "Calibration requires the raw physical camera view.";
  if (!Number.isFinite(frame.capturedAt) || now < frame.capturedAt || now - frame.capturedAt >= 4_000) return "The camera frame is stale. Wait for live video.";
  if (draftFrame && (frame.width !== draftFrame.width || frame.height !== draftFrame.height)) return "The camera resolution changed. Restart the draft before recording points.";
  return null;
}

export function repeatedMachinePointIssue(
  points: Array<{ x: number; y: number } | null>, selectedCorner: number, x: number, y: number,
): string | null {
  const duplicate = points.findIndex((point, index) => index !== selectedCorner && point && Math.hypot(point.x - x, point.y - y) < 5);
  return duplicate < 0 ? null : `The stylus is still at the position recorded for corner ${duplicate + 1}. Move it to corner ${selectedCorner + 1} before capturing XY.`;
}
