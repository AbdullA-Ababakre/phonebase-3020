import {
  PHONEBASE_TAP_DEFAULT_DURATION_MS,
  PHONEBASE_TAP_MAX_DURATION_MS,
  PHONEBASE_TAP_MIN_DURATION_MS,
} from "./action-contract";
import { calibratedScreenPoint, type PhonebaseCalibrationProfile } from "./calibration-profile";

export function buildPhoneKeyCommand(
  profile: PhonebaseCalibrationProfile,
  key: "back" | "home" | "enter",
  touchZ = profile.tap.touchZ,
): {
  action: "tap" | "swipe";
  params: Record<string, number | string>;
  target?: "physical-home-button" | "home-indicator-gesture";
} {
  if (!Number.isFinite(touchZ)) throw new Error("Phone-key touch depth must be finite");
  const common = { touchZ, profileId: profile.id };
  const home = profile.navigation?.home;
  if (key === "home" && !home) throw new Error("Phone Home is not calibrated");
  if (key === "home" && home?.strategy === "physical-button") {
    return { action: "tap", target: "physical-home-button", params: {
      ...common, ...home.machinePoint, durationMs: home.durationMs,
    } };
  }
  if (key === "enter") {
    const enter = phoneEnterKeyGesture();
    return { action: "tap", params: {
      ...common, ...calibratedScreenPoint(profile, enter.point), durationMs: enter.durationMs,
    } };
  }
  const homeSwipe = key === "home" && home?.strategy === "screen-swipe" ? home : null;
  const start = calibratedScreenPoint(profile, homeSwipe?.startPoint ?? { x: 12, y: 780 });
  const end = calibratedScreenPoint(profile, homeSwipe?.endPoint ?? { x: 300, y: 780 });
  // Home is exactly one calibrated swipe. A blind follow-up tap can reopen
  // an app after a successful return to Home. Any recovery needs a new observation.
  return { action: "swipe", ...(homeSwipe ? { target: "home-indicator-gesture" as const } : {}), params: {
    ...common, startX: start.x, startY: start.y, endX: end.x, endY: end.y,
    durationMs: homeSwipe?.durationMs ?? 280,
  } };
}

export const PHONE_ENTER_SCREEN_POINT = Object.freeze({ x: 625, y: 1_388 });

export function phoneEnterKeyGesture() {
  const durationMs = PHONEBASE_TAP_DEFAULT_DURATION_MS;
  if (
    durationMs < PHONEBASE_TAP_MIN_DURATION_MS ||
    durationMs > PHONEBASE_TAP_MAX_DURATION_MS
  ) {
    throw new Error("The configured Enter-key tap is outside the driver tap-duration contract.");
  }
  return {
    action: "tap" as const,
    point: PHONE_ENTER_SCREEN_POINT,
    durationMs,
  };
}

const RECOVERABLE_AGENT_ERROR_CODES = new Set([
  "FRAME_UNAVAILABLE",
  "KEYBOARD_NOT_VISIBLE",
  "KEYBOARD_CASE_UNCLEAR",
  "PHONE_KEY_UNAVAILABLE",
  "VISUAL_TARGET_AMBIGUOUS",
  "VISUAL_TARGET_NOT_FOUND",
]);

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String((error as { code?: unknown }).code ?? "");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Converts safe, pre-contact executor rejections into planner feedback. Hardware
 * alarms, calibration failures, and unknown errors remain fatal and fail closed.
 */
export function recoverableAgentExecutionFeedback(
  error: unknown,
  actionSummary: string,
) {
  const message = errorMessage(error);
  const recoverable = RECOVERABLE_AGENT_ERROR_CODES.has(errorCode(error)) ||
    /Tap duration must be within \d+\.\.\d+ ms/iu.test(message);
  if (!recoverable) return null;
  return `${actionSummary} was safely rejected before completion: ${message} ` +
    "Observe the new frame and choose a materially different valid strategy.";
}
