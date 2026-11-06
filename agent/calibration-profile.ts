import { readFileSync } from "node:fs";
import {
  homographyFromFourPoints,
  mapImagePointToMachine,
  type FourPointCalibration,
  type Point,
} from "./homography";

export type PhonebaseCalibrationProfile = {
  id: string;
  deviceId: string;
  verified: true;
  verifiedAt: string;
  frame: {
    width: number;
    height: number;
  };
  screen: {
    width: number;
    height: number;
  };
  imagePoints: [Point, Point, Point, Point];
  machinePoints: [Point, Point, Point, Point];
  /** Current clean-screen corners in machine space. The camera calibration
   * remains fixed while this value can be refreshed when the phone is reseated. */
  controlMachinePoints?: [Point, Point, Point, Point];
  placementCalibration?: {
    method: "joint-camera-touch-v1";
    verifiedAt: string;
    cameraRmsePx: number;
    cameraMaximumErrorPx: number;
  };
  navigation?: {
    home:
      | {
          strategy: "physical-button";
          machinePoint: Point;
          durationMs: number;
          source: "legacy-ios-16x9-geometry-v1";
        }
      | {
          strategy: "screen-swipe";
          startPoint: Point;
          endPoint: Point;
          durationMs: number;
          source: "ios-face-id-home-v1";
          /** Commissioned pressure for the Home gesture, independent of ordinary touch settings. */
          gestureTouchZ?: number;
          /** Optional independently tested system-gutter recovery; never a dock/app tap. */
          bottomEdgeRecovery?: { point: Point; touchZ: number; verifiedAt: string };
        };
  };
  /** Optional device-specific touch points for a visible iOS Latin keyboard.
   * `strict` prevents an unverified generic key map from being mixed into a
   * physically calibrated sequence. */
  keyboard?: {
    strategy: "screen-point-overrides-v1";
    layout: "ios-latin-qwerty";
    verifiedAt: string;
    strict: true;
    points: Record<string, Point>;
  };
  safeMachineBounds: {
    minimumX: number;
    maximumX: number;
    minimumY: number;
    maximumY: number;
  };
  tap: {
    hoverZ: number;
    touchZ: number;
    normalTouchZ?: number;
    zStep: number;
    feed: number;
    dwellMs: number;
  };
};

export type CalibrationReadiness = {
  ready: boolean;
  reason?: string;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("标定档案必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 不能为空`);
  }
  return value.trim();
}

function numberValue(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} 必须是有限数字`);
  }
  return parsed;
}

function integerValue(value: unknown, label: string): number {
  const parsed = numberValue(value, label);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} 必须是整数`);
  }
  return parsed;
}

function point(value: unknown, label: string): Point {
  const input = record(value);
  return {
    x: numberValue(input.x, `${label}.x`),
    y: numberValue(input.y, `${label}.y`),
  };
}

function fourPoints(
  value: unknown,
  label: string,
): [Point, Point, Point, Point] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${label} 必须恰好包含四个点`);
  }
  return [
    point(value[0], `${label}[0]`),
    point(value[1], `${label}[1]`),
    point(value[2], `${label}[2]`),
    point(value[3], `${label}[3]`),
  ];
}

export function parsePhonebaseCalibrationProfile(
  value: unknown,
): PhonebaseCalibrationProfile {
  const input = record(value);
  if (input.verified !== true) {
    throw new Error("标定档案必须经过人工验证");
  }

  const frameInput = record(input.frame);
  const frame = {
    width: integerValue(frameInput.width, "frame.width"),
    height: integerValue(frameInput.height, "frame.height"),
  };
  if (
    frame.width < 64 ||
    frame.width > 4096 ||
    frame.height < 64 ||
    frame.height > 4096
  ) {
    throw new Error("标定画面尺寸超出允许范围");
  }

  const imagePoints = fourPoints(input.imagePoints, "imagePoints");
  imagePoints.forEach((valuePoint, index) => {
    if (
      valuePoint.x < 0 ||
      valuePoint.x > frame.width ||
      valuePoint.y < 0 ||
      valuePoint.y > frame.height
    ) {
      throw new Error(`imagePoints[${index}] 超出标定画面`);
    }
  });
  const machinePoints = fourPoints(input.machinePoints, "machinePoints");
  const controlMachinePoints = input.controlMachinePoints === undefined
    ? undefined
    : fourPoints(input.controlMachinePoints, "controlMachinePoints");
  let placementCalibration: PhonebaseCalibrationProfile["placementCalibration"];
  if (input.placementCalibration !== undefined) {
    const placement = record(input.placementCalibration);
    if (placement.method !== "joint-camera-touch-v1") {
      throw new Error("placementCalibration.method 无效");
    }
    const cameraRmsePx = numberValue(
      placement.cameraRmsePx,
      "placementCalibration.cameraRmsePx",
    );
    const cameraMaximumErrorPx = numberValue(
      placement.cameraMaximumErrorPx,
      "placementCalibration.cameraMaximumErrorPx",
    );
    if (
      cameraRmsePx < 0 || cameraRmsePx > 10 ||
      cameraMaximumErrorPx < 0 || cameraMaximumErrorPx > 16
    ) {
      throw new Error("物理相机位置验收误差超出允许范围");
    }
    placementCalibration = {
      method: "joint-camera-touch-v1",
      verifiedAt: stringValue(
        placement.verifiedAt,
        "placementCalibration.verifiedAt",
      ),
      cameraRmsePx,
      cameraMaximumErrorPx,
    };
  }

  const screenInput = record(input.screen);
  const screen = {
    width: integerValue(screenInput.width, "screen.width"),
    height: integerValue(screenInput.height, "screen.height"),
  };
  if (
    screen.width < 320 ||
    screen.width > 2160 ||
    screen.height < 480 ||
    screen.height > 4096
  ) {
    throw new Error("校正后屏幕尺寸超出允许范围");
  }

  const boundsInput = record(input.safeMachineBounds);
  const safeMachineBounds = {
    minimumX: numberValue(boundsInput.minimumX, "safeMachineBounds.minimumX"),
    maximumX: numberValue(boundsInput.maximumX, "safeMachineBounds.maximumX"),
    minimumY: numberValue(boundsInput.minimumY, "safeMachineBounds.minimumY"),
    maximumY: numberValue(boundsInput.maximumY, "safeMachineBounds.maximumY"),
  };
  if (
    safeMachineBounds.minimumX >= safeMachineBounds.maximumX ||
    safeMachineBounds.minimumY >= safeMachineBounds.maximumY
  ) {
    throw new Error("标定安全范围无效");
  }
  if (
    safeMachineBounds.minimumX < -300 ||
    safeMachineBounds.maximumX > 300 ||
    safeMachineBounds.minimumY < -300 ||
    safeMachineBounds.maximumY > 300
  ) {
    throw new Error("标定安全范围超出 Phonebase 支持的机械坐标范围");
  }

  const tapInput = record(input.tap);
  const tapValues = {
    hoverZ: numberValue(tapInput.hoverZ, "tap.hoverZ"),
    touchZ: numberValue(tapInput.touchZ, "tap.touchZ"),
    zStep: numberValue(tapInput.zStep, "tap.zStep"),
    feed: numberValue(tapInput.feed, "tap.feed"),
    dwellMs: integerValue(tapInput.dwellMs, "tap.dwellMs"),
  };
  if (
    tapValues.hoverZ < -20 || tapValues.hoverZ > 20 ||
    tapValues.touchZ < -20 || tapValues.touchZ > 20 ||
    tapValues.touchZ === tapValues.hoverZ ||
    tapValues.zStep <= 0 || tapValues.zStep > 5 ||
    tapValues.feed < 1 || tapValues.feed > 20_000 ||
    tapValues.dwellMs < 20 || tapValues.dwellMs > 5_000
  ) {
    throw new Error("标定点击参数超出 Phonebase 支持范围");
  }
  const normalTouchZ = tapInput.normalTouchZ === undefined ? undefined : numberValue(tapInput.normalTouchZ, "tap.normalTouchZ");
  if (normalTouchZ !== undefined && (normalTouchZ < Math.min(tapValues.hoverZ, tapValues.touchZ) || normalTouchZ > Math.max(tapValues.hoverZ, tapValues.touchZ))) {
    throw new Error("tap.normalTouchZ exceeds the commissioned touch range");
  }
  const tap = { ...tapValues, ...(normalTouchZ === undefined ? {} : { normalTouchZ }) };

  let navigation: PhonebaseCalibrationProfile["navigation"];
  if (input.navigation !== undefined) {
    const navigationInput = record(input.navigation);
    const homeInput = record(navigationInput.home);
    if (homeInput.strategy === "physical-button") {
      if (homeInput.source !== "legacy-ios-16x9-geometry-v1") {
        throw new Error("navigation.home.source 无效");
      }
      const machinePoint = point(
        homeInput.machinePoint,
        "navigation.home.machinePoint",
      );
      if (
        machinePoint.x < safeMachineBounds.minimumX ||
        machinePoint.x > safeMachineBounds.maximumX ||
        machinePoint.y < safeMachineBounds.minimumY ||
        machinePoint.y > safeMachineBounds.maximumY
      ) {
        throw new Error("实体 Home 键坐标超出机械臂安全范围");
      }
      navigation = {
        home: {
          strategy: "physical-button",
          machinePoint,
          durationMs: integerValue(
            homeInput.durationMs,
            "navigation.home.durationMs",
          ),
          source: "legacy-ios-16x9-geometry-v1",
        },
      };
    } else if (homeInput.strategy === "screen-swipe") {
      if (homeInput.source !== "ios-face-id-home-v1") {
        throw new Error("navigation.home.source 无效");
      }
      const startPoint = point(homeInput.startPoint, "navigation.home.startPoint");
      const endPoint = point(homeInput.endPoint, "navigation.home.endPoint");
      const gestureTouchZ = homeInput.gestureTouchZ === undefined ? undefined :
        numberValue(homeInput.gestureTouchZ, "navigation.home.gestureTouchZ");
      if (gestureTouchZ !== undefined && (gestureTouchZ < 9.5 || gestureTouchZ > 10)) {
        throw new Error("Home gesture pressure exceeds the commissioned range.");
      }
      let bottomEdgeRecovery: { point: Point; touchZ: number; verifiedAt: string } | undefined;
      if (homeInput.bottomEdgeRecovery !== undefined) {
        const recovery = record(homeInput.bottomEdgeRecovery);
        const recoveryPoint = point(recovery.point, "navigation.home.bottomEdgeRecovery.point");
        const touchZ = numberValue(recovery.touchZ, "navigation.home.bottomEdgeRecovery.touchZ");
        if (recoveryPoint.x < screen.width * 0.45 || recoveryPoint.x > screen.width * 0.55 ||
            recoveryPoint.y < screen.height * 0.975 || recoveryPoint.y > screen.height * 0.995 ||
            touchZ < 9.5 || touchZ > 10) {
          throw new Error("Home recovery must stay in the verified bottom-center system gutter and pressure range.");
        }
        const verifiedAt = stringValue(recovery.verifiedAt, "navigation.home.bottomEdgeRecovery.verifiedAt");
        if (!Number.isFinite(Date.parse(verifiedAt))) throw new Error("Home recovery requires a valid verification date.");
        bottomEdgeRecovery = { point: recoveryPoint, touchZ, verifiedAt };
      }
      for (const [label, navigationPoint] of [
        ["startPoint", startPoint],
        ["endPoint", endPoint],
      ] as const) {
        if (
          navigationPoint.x < 0 || navigationPoint.x > screen.width ||
          navigationPoint.y < 0 || navigationPoint.y > screen.height
        ) {
          throw new Error(`navigation.home.${label} 超出校正后的屏幕画面`);
        }
      }
      if (
        startPoint.y < screen.height * 0.88 ||
        endPoint.y > screen.height * 0.8 ||
        endPoint.y >= startPoint.y - screen.height * 0.12 ||
        Math.abs(startPoint.x - endPoint.x) > screen.width * 0.15
      ) {
        throw new Error("Face ID Home 手势必须从屏幕底部向上滑动");
      }
      navigation = {
        home: {
          strategy: "screen-swipe",
          startPoint,
          endPoint,
          durationMs: integerValue(
            homeInput.durationMs,
            "navigation.home.durationMs",
          ),
          source: "ios-face-id-home-v1",
          ...(gestureTouchZ !== undefined ? { gestureTouchZ } : {}),
          ...(bottomEdgeRecovery ? { bottomEdgeRecovery } : {}),
        },
      };
    } else {
      throw new Error("navigation.home.strategy 无效");
    }
    if (
      navigation.home.durationMs < 50 ||
      navigation.home.durationMs > 1_000
    ) {
      throw new Error("实体 Home 键按压时间超出允许范围");
    }
  }

  let keyboard: PhonebaseCalibrationProfile["keyboard"];
  if (input.keyboard !== undefined) {
    const keyboardInput = record(input.keyboard);
    if (keyboardInput.strategy !== "screen-point-overrides-v1") {
      throw new Error("keyboard.strategy 无效");
    }
    if (keyboardInput.layout !== "ios-latin-qwerty") {
      throw new Error("keyboard.layout 无效");
    }
    if (keyboardInput.strict !== true) {
      throw new Error("keyboard.strict 必须为 true，禁止混用未经验证的键位");
    }
    const pointsInput = record(keyboardInput.points);
    const points: Record<string, Point> = {};
    for (const [key, value] of Object.entries(pointsInput)) {
      if (!key.trim() || key.length > 16) {
        throw new Error("keyboard.points 包含无效键名");
      }
      const keyPoint = point(value, `keyboard.points.${key}`);
      if (
        keyPoint.x < 0 || keyPoint.x > screen.width ||
        keyPoint.y < 0 || keyPoint.y > screen.height
      ) {
        throw new Error(`keyboard.points.${key} 超出校正后的屏幕画面`);
      }
      points[key] = keyPoint;
    }
    if (!Object.keys(points).length) {
      throw new Error("keyboard.points 至少需要一个已验证键位");
    }
    keyboard = {
      strategy: "screen-point-overrides-v1",
      layout: "ios-latin-qwerty",
      verifiedAt: stringValue(keyboardInput.verifiedAt, "keyboard.verifiedAt"),
      strict: true,
      points,
    };
  }

  const profile: PhonebaseCalibrationProfile = {
    id: stringValue(input.id, "id"),
    deviceId: stringValue(input.deviceId, "deviceId"),
    verified: true,
    verifiedAt: stringValue(input.verifiedAt, "verifiedAt"),
    frame,
    screen,
    imagePoints,
    machinePoints,
    ...(controlMachinePoints ? { controlMachinePoints } : {}),
    ...(placementCalibration ? { placementCalibration } : {}),
    ...(navigation ? { navigation } : {}),
    ...(keyboard ? { keyboard } : {}),
    safeMachineBounds,
    tap,
  };
  // Force the projective transform to be solved at startup so a degenerate
  // four-point profile can never make touch capabilities available.
  homographyFromFourPoints(profile.imagePoints, profile.machinePoints);
  if (profile.navigation?.home.strategy === "screen-swipe" && profile.navigation.home.bottomEdgeRecovery) {
    calibratedScreenPoint(profile, profile.navigation.home.bottomEdgeRecovery.point);
  }
  return profile;
}

export function loadPhonebaseCalibrationProfile(
  path = process.env.PHONEBASE_CALIBRATION_PATH,
): PhonebaseCalibrationProfile | null {
  if (!path?.trim()) return null;
  try {
    return parsePhonebaseCalibrationProfile(
      JSON.parse(readFileSync(path.trim(), "utf8")),
    );
  } catch (error) {
    // A newly bound device has no calibration file yet. Treat that state as
    // intentionally uncommissioned so its camera/status node can start in
    // view-only mode while all coordinate-based actions remain locked.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function calibrationReadiness(
  profile: PhonebaseCalibrationProfile | null,
  input: {
    deviceId: string;
    frame: { width: number; height: number } | null;
  },
): CalibrationReadiness {
  if (!profile) {
    return {
      ready: false,
      reason: "A verified four-point physical calibration profile is required.",
    };
  }
  if (/^(?:unconfigured|placeholder|default)$/i.test(profile.id)) {
    return {
      ready: false,
      reason: "A device-specific verified touch profile is required.",
    };
  }
  if (profile.deviceId !== input.deviceId) {
    return {
      ready: false,
      reason: "The physical calibration profile belongs to another device.",
    };
  }
  if (!input.frame) {
    return {
      ready: false,
      reason: "A fresh camera frame is required.",
    };
  }
  if (
    profile.frame.width !== input.frame.width ||
    profile.frame.height !== input.frame.height
  ) {
    return {
      ready: false,
      reason: "The camera frame size does not match the calibration profile.",
    };
  }
  return { ready: true };
}

export function calibratedMachinePoint(
  profile: PhonebaseCalibrationProfile,
  imagePoint: Point,
): Point {
  const calibration: FourPointCalibration = {
    imagePoints: profile.imagePoints,
    machinePoints: profile.machinePoints,
  };
  const mapped = mapImagePointToMachine(calibration, imagePoint);
  const bounds = profile.safeMachineBounds;
  if (
    mapped.x < bounds.minimumX ||
    mapped.x > bounds.maximumX ||
    mapped.y < bounds.minimumY ||
    mapped.y > bounds.maximumY
  ) {
    throw new Error("目标点映射后超出已验证的屏幕安全范围");
  }
  return {
    x: Math.round(mapped.x * 1000) / 1000,
    y: Math.round(mapped.y * 1000) / 1000,
  };
}

/**
 * Maps a point from the rectified screen shown to the operator into machine
 * space. Unlike calibratedMachinePoint(), this transform is independent of
 * camera perspective because the operator works in the flat screen viewport.
 */
export function calibratedScreenPoint(
  profile: PhonebaseCalibrationProfile,
  screenPoint: Point,
): Point {
  const { width, height } = profile.screen;
  if (
    screenPoint.x < 0 ||
    screenPoint.x > width ||
    screenPoint.y < 0 ||
    screenPoint.y > height
  ) {
    throw new Error("目标点超出校正后的屏幕画面");
  }
  const calibration: FourPointCalibration = {
    imagePoints: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    machinePoints: profile.controlMachinePoints ?? profile.machinePoints,
  };
  const mapped = mapImagePointToMachine(calibration, screenPoint);
  const bounds = profile.safeMachineBounds;
  if (
    mapped.x < bounds.minimumX ||
    mapped.x > bounds.maximumX ||
    mapped.y < bounds.minimumY ||
    mapped.y > bounds.maximumY
  ) {
    throw new Error("目标点映射后超出已验证的屏幕安全范围");
  }
  return {
    x: Math.round(mapped.x * 1000) / 1000,
    y: Math.round(mapped.y * 1000) / 1000,
  };
}
