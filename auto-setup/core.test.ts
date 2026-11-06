import assert from "node:assert/strict";
import test from "node:test";
import type { PhonebaseCalibrationProfile } from "../agent/calibration-profile";
import type { VisionRegistrationResult } from "../agent/vision-register";
import {
  autoSetupReferenceIntegrityIssue,
  buildRegisteredAutoSetup,
  buildVisionBaselineProfile,
  calibrationFingerprint,
  profileWithPhoneModelNavigation,
  type AutoSetupReference,
} from "./core";

const profile: PhonebaseCalibrationProfile = {
  id: "fixture-v1",
  deviceId: "black-arm-01",
  verified: true,
  verifiedAt: "2026-08-01T00:00:00.000Z",
  frame: { width: 720, height: 1280 },
  screen: { width: 720, height: 1560 },
  imagePoints: [
    { x: 100, y: 80 },
    { x: 620, y: 80 },
    { x: 620, y: 1200 },
    { x: 100, y: 1200 },
  ],
  machinePoints: [
    { x: 70, y: 146 },
    { x: 14, y: 146 },
    { x: 14, y: 14 },
    { x: 70, y: 14 },
  ],
  safeMachineBounds: {
    minimumX: 15,
    maximumX: 69,
    minimumY: 15,
    maximumY: 145,
  },
  navigation: {
    home: {
      strategy: "physical-button",
      machinePoint: { x: 42, y: 140 },
      durationMs: 120,
      source: "legacy-ios-16x9-geometry-v1",
    },
  },
  tap: { hoverZ: 1, touchZ: 10, zStep: 0.5, feed: 3000, dwellMs: 40 },
};
const calibrationSha256 = calibrationFingerprint(profile);

const reference: AutoSetupReference = {
  version: 2,
  deviceId: profile.deviceId,
  calibrationId: profile.id,
  capturedAt: "2026-08-01T00:00:00.000Z",
  baselineCalibrationSha256: calibrationSha256,
  authorizedCalibrationSha256: calibrationSha256,
  frame: { width: 720, height: 1280, sequence: 12, sha256: "a".repeat(64) },
  calibration: profile,
};

function registration(matrix: VisionRegistrationResult["referenceToCurrentVision"]): VisionRegistrationResult {
  return {
    ok: true,
    confidence: 0.98,
    elapsedMs: 48,
    referenceWidth: 720,
    referenceHeight: 1280,
    currentWidth: 720,
    currentHeight: 1280,
    referenceToCurrentVision: matrix,
  };
}

const movementBounds = {
  minimumX: 5.8,
  maximumX: 78.5,
  minimumY: 10.5,
  maximumY: 168,
};

test("reuses an unchanged camera reference without moving calibration", () => {
  const result = buildRegisteredAutoSetup({
    reference,
    currentProfile: profile,
    registration: registration([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    movementBounds,
    now: new Date("2026-08-28T00:00:00.000Z"),
  });
  assert.deepEqual(result.imagePoints, profile.imagePoints);
  assert.deepEqual(result.machinePoints, profile.machinePoints);
  assert.equal(result.meanDriftPx, 0);
  assert.equal(result.profile.verifiedAt, "2026-08-28T00:00:00.000Z");
  assert.equal(result.profile.navigation, undefined);
});

test("derives a safe Face ID Home gesture from the one-time model choice", () => {
  const withoutNavigation = { ...profile };
  delete withoutNavigation.navigation;
  const updated = profileWithPhoneModelNavigation(
    withoutNavigation,
    "iphone-face-id",
  );
  assert.equal(updated.navigation?.home.strategy, "screen-swipe");
  if (updated.navigation?.home.strategy !== "screen-swipe") {
    assert.fail("Expected a screen-relative Face ID Home gesture.");
  }
  assert.deepEqual(updated.navigation.home.startPoint, { x: 360, y: 1528.8 });
  assert.deepEqual(updated.navigation.home.endPoint, { x: 360, y: 1060.8 });
  assert.equal(updated.navigation.home.durationMs, 320);
});

test("keeps a Face ID Home gesture through visual phone recovery", () => {
  const faceIdProfile = profileWithPhoneModelNavigation(
    { ...profile, navigation: undefined },
    "iphone-face-id",
  );
  const faceIdReference: AutoSetupReference = {
    ...reference,
    baselineCalibrationSha256: calibrationFingerprint(faceIdProfile),
    authorizedCalibrationSha256: calibrationFingerprint(faceIdProfile),
    calibration: faceIdProfile,
  };
  const result = buildRegisteredAutoSetup({
    reference: faceIdReference,
    currentProfile: faceIdProfile,
    registration: registration([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    movementBounds,
  });
  assert.equal(result.profile.navigation?.home.strategy, "screen-swipe");
});

test("binds a trusted frame to its exact baseline calibration", () => {
  assert.equal(autoSetupReferenceIntegrityIssue({
    reference,
    expectedDeviceId: profile.deviceId,
    imageSha256: reference.frame.sha256,
  }), null);
  assert.match(autoSetupReferenceIntegrityIssue({
    reference: {
      ...reference,
      calibration: {
        ...reference.calibration,
        imagePoints: [
          { x: 101, y: 80 },
          ...reference.calibration.imagePoints.slice(1),
        ] as PhonebaseCalibrationProfile["imagePoints"],
      },
    },
    expectedDeviceId: profile.deviceId,
    imageSha256: reference.frame.sha256,
  }) ?? "", /baseline calibration hash/i);
});

test("adopts reviewed vision corners without changing verified machine corners", () => {
  const updated = buildVisionBaselineProfile({
    currentProfile: {
      ...profile,
      placementCalibration: {
        method: "joint-camera-touch-v1",
        verifiedAt: "2026-08-01T00:00:00.000Z",
        cameraRmsePx: 2,
        cameraMaximumErrorPx: 4,
      },
    },
    imagePoints: [
      { x: 71.1234, y: 12.2222 },
      { x: 624.8888, y: 12.1111 },
      { x: 640.5555, y: 1211.4444 },
      { x: 87.7777, y: 1211.3333 },
    ],
    frame: { width: 720, height: 1280 },
    now: new Date("2026-08-28T01:02:03.000Z"),
  });
  assert.deepEqual(updated.imagePoints[0], { x: 71.123, y: 12.222 });
  assert.deepEqual(updated.machinePoints, profile.machinePoints);
  assert.deepEqual(updated.safeMachineBounds, profile.safeMachineBounds);
  assert.equal(updated.verifiedAt, "2026-08-28T01:02:03.000Z");
  assert.equal(updated.placementCalibration, undefined);
});

test("translates camera and machine corners after the phone is reseated", () => {
  const result = buildRegisteredAutoSetup({
    reference,
    currentProfile: profile,
    registration: registration([1, 0, 12, 0, 1, -8, 0, 0, 1]),
    movementBounds,
  });
  assert.deepEqual(result.imagePoints[0], { x: 112, y: 88 });
  assert.ok(Math.abs(result.machinePoints[0].x - 68.708) < 0.002);
  assert.ok(Math.abs(result.machinePoints[0].y - 145.057) < 0.002);
  assert.ok(result.maximumDriftPx > 14 && result.maximumDriftPx < 15);
});

test("fails closed on low-confidence visual registration", () => {
  assert.throws(() => buildRegisteredAutoSetup({
    reference,
    currentProfile: profile,
    registration: { ...registration([1, 0, 0, 0, 1, 0, 0, 0, 1]), confidence: 0.4 },
    movementBounds,
  }), /confidence/);
});

test("fails closed when the registered phone leaves the camera frame", () => {
  assert.throws(() => buildRegisteredAutoSetup({
    reference,
    currentProfile: profile,
    registration: registration([1, 0, 260, 0, 1, 0, 0, 0, 1]),
    movementBounds,
  }), /moved too far|outside the camera frame/);
});

test("fails closed when registration shears the screen instead of moving it", () => {
  assert.throws(() => buildRegisteredAutoSetup({
    reference,
    currentProfile: profile,
    registration: registration([1, 0.15, -100, 0, 1, 0, 0, 0, 1]),
    movementBounds,
  }), /distorted/);
});

