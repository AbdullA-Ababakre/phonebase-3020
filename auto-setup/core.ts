import { createHash } from "node:crypto";
import {
  calibratedScreenPoint,
  parsePhonebaseCalibrationProfile,
  type PhonebaseCalibrationProfile,
} from "../agent/calibration-profile";
import { mapImagePointToMachine, type Point } from "../agent/homography";
import {
  referencePointsInCurrentFrame,
  type VisionRegistrationResult,
} from "../agent/vision-register";
import { calibrationReadinessIssue } from "../shared/calibration-readiness";

export type AutoSetupReference = {
  version: 2;
  deviceId: string;
  calibrationId: string;
  capturedAt: string;
  baselineCalibrationSha256: string;
  authorizedCalibrationSha256: string;
  frame: {
    width: number;
    height: number;
    sequence: number;
    sha256: string;
  };
  calibration: PhonebaseCalibrationProfile;
};

export type AutoSetupMovementBounds = {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
};

export type AutoSetupRegistration = {
  imagePoints: [Point, Point, Point, Point];
  machinePoints: [Point, Point, Point, Point];
  controlMachinePoints?: [Point, Point, Point, Point];
  meanDriftPx: number;
  maximumDriftPx: number;
  confidence: number;
  elapsedMs: number;
  profile: PhonebaseCalibrationProfile;
};

const MINIMUM_REGISTRATION_CONFIDENCE = 0.78;
const MAXIMUM_MEAN_DRIFT_RATIO = 0.16;
const MAXIMUM_CORNER_DRIFT_RATIO = 0.24;
const MINIMUM_EDGE_SCALE = 0.82;
const MAXIMUM_EDGE_SCALE = 1.18;
const MINIMUM_AREA_SCALE = 0.72;
const MAXIMUM_AREA_SCALE = 1.28;
const MAXIMUM_CORNER_ANGLE_CHANGE_DEGREES = 8;

export function calibrationFingerprint(profile: PhonebaseCalibrationProfile) {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

export function autoSetupReferenceIntegrityIssue(input: {
  reference: AutoSetupReference;
  expectedDeviceId: string;
  imageSha256: string;
}) {
  const { reference } = input;
  if (reference.version !== 2) return "Unsupported visual-reference version.";
  if (reference.deviceId !== input.expectedDeviceId) {
    return "The visual reference belongs to another device.";
  }
  if (reference.frame.sha256 !== input.imageSha256) {
    return "The visual-reference image hash does not match its metadata.";
  }
  if (
    reference.baselineCalibrationSha256 !==
      calibrationFingerprint(reference.calibration)
  ) {
    return "The baseline calibration hash does not match its metadata.";
  }
  if (!/^[a-f0-9]{64}$/.test(reference.authorizedCalibrationSha256)) {
    return "The authorized calibration hash is invalid.";
  }
  return null;
}

function distance(left: Point, right: Point) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function polygonArea(points: [Point, Point, Point, Point]) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}

function cornerAngleDegrees(
  points: [Point, Point, Point, Point],
  index: number,
) {
  const point = points[index];
  const previous = points[(index + points.length - 1) % points.length];
  const next = points[(index + 1) % points.length];
  const left = { x: previous.x - point.x, y: previous.y - point.y };
  const right = { x: next.x - point.x, y: next.y - point.y };
  const denominator = Math.hypot(left.x, left.y) * Math.hypot(right.x, right.y);
  if (!Number.isFinite(denominator) || denominator < 1e-6) return Number.NaN;
  const cosine = Math.max(-1, Math.min(1, (
    left.x * right.x + left.y * right.y
  ) / denominator));
  return Math.acos(cosine) * 180 / Math.PI;
}

function registrationGeometryIssue(
  baseline: [Point, Point, Point, Point],
  registered: [Point, Point, Point, Point],
) {
  const edgeScales = baseline.map((point, index) => {
    const baselineLength = distance(point, baseline[(index + 1) % baseline.length]);
    const registeredLength = distance(
      registered[index],
      registered[(index + 1) % registered.length],
    );
    return registeredLength / baselineLength;
  });
  if (edgeScales.some((scale) =>
    !Number.isFinite(scale) ||
    scale < MINIMUM_EDGE_SCALE ||
    scale > MAXIMUM_EDGE_SCALE
  )) {
    return "Visual registration distorted a screen edge beyond the allowed scale.";
  }
  const areaScale = polygonArea(registered) / polygonArea(baseline);
  if (
    !Number.isFinite(areaScale) ||
    areaScale < MINIMUM_AREA_SCALE ||
    areaScale > MAXIMUM_AREA_SCALE
  ) {
    return "Visual registration distorted the screen area beyond the allowed scale.";
  }
  const angleChanges = baseline.map((_, index) => Math.abs(
    cornerAngleDegrees(registered, index) - cornerAngleDegrees(baseline, index)
  ));
  if (angleChanges.some((change) =>
    !Number.isFinite(change) || change > MAXIMUM_CORNER_ANGLE_CHANGE_DEGREES
  )) {
    return "Visual registration distorted the screen corner angles.";
  }
  return null;
}

function finiteBounds(bounds: AutoSetupMovementBounds) {
  const values = [
    bounds.minimumX,
    bounds.maximumX,
    bounds.minimumY,
    bounds.maximumY,
  ];
  if (
    !values.every(Number.isFinite) ||
    bounds.minimumX >= bounds.maximumX ||
    bounds.minimumY >= bounds.maximumY
  ) {
    throw new Error("The hardware node did not publish valid movement bounds.");
  }
  return bounds;
}

function mappedMachineCorners(
  reference: AutoSetupReference,
  imagePoints: [Point, Point, Point, Point],
  useControlPoints: boolean,
) {
  const baseline = reference.calibration;
  const machinePoints = useControlPoints
    ? baseline.controlMachinePoints ?? baseline.machinePoints
    : baseline.machinePoints;
  return imagePoints.map((point) => mapImagePointToMachine({
    imagePoints: baseline.imagePoints,
    machinePoints,
  }, point)) as [Point, Point, Point, Point];
}

function roundedPoints(points: [Point, Point, Point, Point]) {
  return points.map((point) => ({
    x: Math.round(point.x * 1_000) / 1_000,
    y: Math.round(point.y * 1_000) / 1_000,
  })) as [Point, Point, Point, Point];
}

function roundedPoint(point: Point): Point {
  return {
    x: Math.round(point.x * 1_000) / 1_000,
    y: Math.round(point.y * 1_000) / 1_000,
  };
}

/**
 * Adds only navigation that can be derived from the operator's one-time phone
 * model choice. Every generated screen point must still map into the active
 * profile's verified machine bounds before the capability can be installed.
 */
export function profileWithPhoneModelNavigation(
  profile: PhonebaseCalibrationProfile,
  phoneModelId: string,
): PhonebaseCalibrationProfile {
  if (phoneModelId !== "iphone-face-id") {
    if (profile.navigation?.home.strategy !== "screen-swipe") return profile;
    const updated = { ...profile };
    delete updated.navigation;
    return updated;
  }

  const x = profile.screen.width * 0.5;
  const endPoint = roundedPoint({ x, y: profile.screen.height * 0.68 });
  const startPoint = [0.98, 0.96, 0.94, 0.92, 0.9, 0.88]
    .map((ratio) => roundedPoint({ x, y: profile.screen.height * ratio }))
    .find((candidate) => {
      try {
        calibratedScreenPoint(profile, candidate);
        calibratedScreenPoint(profile, endPoint);
        return true;
      } catch {
        return false;
      }
    });
  if (!startPoint) {
    const updated = { ...profile };
    delete updated.navigation;
    return updated;
  }

  return parsePhonebaseCalibrationProfile({
    ...profile,
    navigation: {
      home: {
        strategy: "screen-swipe",
        startPoint,
        endPoint,
        durationMs: 320,
        source: "ios-face-id-home-v1",
      },
    },
  });
}

export function buildVisionBaselineProfile(input: {
  currentProfile: PhonebaseCalibrationProfile;
  imagePoints: [Point, Point, Point, Point];
  frame: { width: number; height: number };
  now?: Date;
}) {
  const imagePoints = roundedPoints(input.imagePoints);
  if (imagePoints.some((point) =>
    point.x < 0 || point.x > input.frame.width ||
    point.y < 0 || point.y > input.frame.height
  )) {
    throw new Error("The detected screen corners extend outside the camera frame.");
  }
  const machinePoints = input.currentProfile.controlMachinePoints ??
    input.currentProfile.machinePoints;
  const geometryIssue = calibrationReadinessIssue({ imagePoints, machinePoints });
  if (geometryIssue) throw new Error(geometryIssue);
  const profile: PhonebaseCalibrationProfile = {
    ...input.currentProfile,
    verifiedAt: (input.now ?? new Date()).toISOString(),
    frame: { ...input.frame },
    imagePoints,
  };
  // The operator verifies the camera outline here. A previous joint camera/
  // touch error measurement no longer describes the updated camera points.
  delete profile.placementCalibration;
  return profile;
}

export function buildRegisteredAutoSetup(input: {
  reference: AutoSetupReference;
  currentProfile: PhonebaseCalibrationProfile;
  registration: VisionRegistrationResult;
  movementBounds: AutoSetupMovementBounds;
  now?: Date;
}): AutoSetupRegistration {
  const { reference, currentProfile, registration } = input;
  if (
    reference.version !== 2 ||
    reference.deviceId !== currentProfile.deviceId ||
    reference.calibrationId !== currentProfile.id ||
    reference.calibration.id !== currentProfile.id
  ) {
    throw new Error("The saved visual reference does not belong to this device profile.");
  }
  if (
    registration.referenceWidth !== reference.frame.width ||
    registration.referenceHeight !== reference.frame.height ||
    registration.currentWidth !== reference.frame.width ||
    registration.currentHeight !== reference.frame.height
  ) {
    throw new Error("The camera resolution changed after the visual reference was saved.");
  }
  if (registration.confidence < MINIMUM_REGISTRATION_CONFIDENCE) {
    throw new Error(
      `Camera registration confidence ${registration.confidence.toFixed(3)} is below ` +
        `${MINIMUM_REGISTRATION_CONFIDENCE.toFixed(2)}.`,
    );
  }

  const rawImagePoints = referencePointsInCurrentFrame(
    registration.referenceToCurrentVision,
    reference.calibration.imagePoints,
    registration.currentHeight,
  );
  const frameDiagonal = Math.hypot(reference.frame.width, reference.frame.height);
  const drift = rawImagePoints.map((point, index) =>
    distance(point, reference.calibration.imagePoints[index])
  );
  const meanDriftPx = drift.reduce((sum, value) => sum + value, 0) / drift.length;
  const maximumDriftPx = Math.max(...drift);
  if (
    meanDriftPx > frameDiagonal * MAXIMUM_MEAN_DRIFT_RATIO ||
    maximumDriftPx > frameDiagonal * MAXIMUM_CORNER_DRIFT_RATIO
  ) {
    throw new Error(
      `The phone moved too far for automatic recovery ` +
        `(mean ${meanDriftPx.toFixed(1)} px, max ${maximumDriftPx.toFixed(1)} px).`,
    );
  }
  if (rawImagePoints.some((point) =>
    point.x < -2 || point.x > reference.frame.width + 2 ||
    point.y < -2 || point.y > reference.frame.height + 2
  )) {
    throw new Error("The registered screen corners extend outside the camera frame.");
  }
  const registrationIssue = registrationGeometryIssue(
    reference.calibration.imagePoints,
    rawImagePoints,
  );
  if (registrationIssue) throw new Error(registrationIssue);

  const imagePoints = roundedPoints(rawImagePoints);
  const machinePoints = roundedPoints(mappedMachineCorners(reference, imagePoints, false));
  const controlMachinePoints = reference.calibration.controlMachinePoints
    ? roundedPoints(mappedMachineCorners(reference, imagePoints, true))
    : undefined;
  const geometryIssue = calibrationReadinessIssue({
    imagePoints,
    machinePoints: controlMachinePoints ?? machinePoints,
  });
  if (geometryIssue) throw new Error(geometryIssue);

  const movementBounds = finiteBounds(input.movementBounds);
  const safetyPoints = controlMachinePoints ?? machinePoints;
  if (safetyPoints.some((point) =>
    point.x < movementBounds.minimumX || point.x > movementBounds.maximumX ||
    point.y < movementBounds.minimumY || point.y > movementBounds.maximumY
  )) {
    throw new Error("The recovered phone corners are outside the hardware movement envelope.");
  }
  const xs = safetyPoints.map((point) => point.x);
  const ys = safetyPoints.map((point) => point.y);
  const safeMachineBounds = {
    minimumX: Math.max(Math.min(...xs) + 0.5, movementBounds.minimumX),
    maximumX: Math.min(Math.max(...xs) - 0.5, movementBounds.maximumX),
    minimumY: Math.max(Math.min(...ys) + 0.5, movementBounds.minimumY),
    maximumY: Math.min(Math.max(...ys) - 0.5, movementBounds.maximumY),
  };
  if (
    safeMachineBounds.minimumX >= safeMachineBounds.maximumX ||
    safeMachineBounds.minimumY >= safeMachineBounds.maximumY
  ) {
    throw new Error("Automatic recovery produced an empty safe touch area.");
  }

  const profile: PhonebaseCalibrationProfile = {
    ...currentProfile,
    verifiedAt: (input.now ?? new Date()).toISOString(),
    frame: {
      width: registration.currentWidth,
      height: registration.currentHeight,
    },
    imagePoints,
    machinePoints,
    ...(controlMachinePoints ? { controlMachinePoints } : {}),
    safeMachineBounds,
    // A physical Home button sits outside the registered screen and cannot be
    // recovered safely. A Face ID gesture remains screen-relative, so it can
    // survive visual recovery after both points pass the calibrated map.
    navigation: currentProfile.navigation?.home.strategy === "screen-swipe"
      ? currentProfile.navigation
      : undefined,
    placementCalibration: undefined,
  };
  return {
    imagePoints,
    machinePoints,
    ...(controlMachinePoints ? { controlMachinePoints } : {}),
    meanDriftPx: Math.round(meanDriftPx * 1_000) / 1_000,
    maximumDriftPx: Math.round(maximumDriftPx * 1_000) / 1_000,
    confidence: registration.confidence,
    elapsedMs: registration.elapsedMs,
    profile,
  };
}
