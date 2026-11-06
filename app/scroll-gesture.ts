import { homographyFromFourPoints, projectPoint, type Point } from "../agent/homography";
import { mapCameraPointToScreen } from "./pointer-geometry";

export const SCROLL_COALESCE_MS = 110;
export const SCROLL_INTENT_TTL_MS = 700;
export function swipeDuration(ms: number) {
  return Math.max(250, Math.min(1_200, Math.round(Number.isFinite(ms) ? ms : 350)));
}

export function wheelPixels(deltaX: number, deltaY: number, mode: number, pageHeight: number) {
  const scale = mode === 1 ? 16 : mode === 2 ? pageHeight : 1;
  return { x: Number.isFinite(deltaX) ? deltaX * scale : 0, y: Number.isFinite(deltaY) ? deltaY * scale : 0 };
}

export type ScrollIntent = { axis: "x" | "y"; amount: number; anchor: Point; at: number };
/** One bounded pending intent, never a queue of stale physical actions. */
export class ScrollIntentBuffer {
  private pending: ScrollIntent | null = null;
  add(delta: Point, anchor: Point, displayed: { width: number; height: number }, now: number) {
    const axis = Math.abs(delta.y) >= Math.abs(delta.x) ? "y" : "x";
    const extent = axis === "y" ? displayed.height : displayed.width;
    if (!Number.isFinite(extent) || extent <= 0 || !Number.isFinite(delta[axis]) || delta[axis] === 0) return;
    const amount = delta[axis] / extent;
    const previous = this.pending;
    const combine = previous && now - previous.at <= SCROLL_INTENT_TTL_MS &&
      previous.axis === axis && Math.sign(previous.amount) === Math.sign(amount);
    this.pending = { axis, amount: Math.max(-0.42, Math.min(0.42, amount + (combine ? previous.amount : 0))), anchor, at: now };
  }
  hasPending() { return this.pending !== null; }
  clear() { this.pending = null; }
  take(now: number) {
    const intent = this.pending;
    this.clear();
    return intent && now - intent.at <= SCROLL_INTENT_TTL_MS && now >= intent.at && Math.abs(intent.amount) >= 0.015 ? intent : null;
  }
}

export function scrollGesture(intent: ScrollIntent, frame: {
  width: number; height: number; sequence: number;
  camera: boolean; imagePoints?: [Point, Point, Point, Point] | null;
}, screen: { width: number; height: number }, safe?: { left: number; top: number; right: number; bottom: number }) {
  if (![screen.width, screen.height, frame.width, frame.height, frame.sequence].every(n => Number.isFinite(n) && n > 0)) return null;
  if (frame.camera && !frame.imagePoints) return null;
  const anchor = frame.camera
    ? mapCameraPointToScreen(intent.anchor, frame.imagePoints!, screen)
    : { x: intent.anchor.x * screen.width / frame.width, y: intent.anchor.y * screen.height / frame.height };
  if (!anchor || anchor.x < 0 || anchor.x > screen.width || anchor.y < 0 || anchor.y > screen.height) return null;
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const left = Math.max(safe?.left ?? 0, screen.width * 0.12);
  const right = Math.min(safe?.right ?? screen.width, screen.width * 0.88);
  const top = Math.max(safe?.top ?? 0, screen.height * 0.22);
  const bottom = Math.min(safe?.bottom ?? screen.height, screen.height * 0.80);
  if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  const vertical = intent.axis === "y";
  const extent = vertical ? screen.height : screen.width;
  const span = Math.min((vertical ? bottom - top : right - left) * 0.85,
    extent * clamp(Math.abs(intent.amount), 0.06, 0.42));
  const center = vertical ? (top + bottom) / 2 : (left + right) / 2;
  const travel = span * Math.sign(intent.amount) / 2;
  if (!Number.isFinite(travel) || travel === 0) return null;
  let start = vertical ? { x: clamp(anchor.x, left, right), y: center + travel } : { x: center + travel, y: clamp(anchor.y, top, bottom) };
  let end = vertical ? { x: start.x, y: center - travel } : { x: center - travel, y: start.y };
  // Actions retain the displayed frame's exact coordinate space. The server
  // applies the physical calibration once, including rotated camera views.
  if (frame.camera) {
    try {
      const transform = homographyFromFourPoints([
        { x: 0, y: 0 }, { x: screen.width, y: 0 },
        { x: screen.width, y: screen.height }, { x: 0, y: screen.height },
      ], frame.imagePoints!);
      start = projectPoint(transform, start); end = projectPoint(transform, end);
    } catch { return null; }
  } else {
    start = { x: start.x * frame.width / screen.width, y: start.y * frame.height / screen.height };
    end = { x: end.x * frame.width / screen.width, y: end.y * frame.height / screen.height };
  }
  if (![start, end].every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= frame.width && p.y <= frame.height)) return null;
  return { type: "swipe" as const, start, end, viewport: { width: frame.width, height: frame.height },
    frameSequence: frame.sequence, durationMs: swipeDuration(250 + Math.abs(intent.amount) * 400) };
}
