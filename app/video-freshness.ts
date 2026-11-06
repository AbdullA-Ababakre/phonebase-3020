export const VIDEO_STALE_AFTER_MS = 4_000;
export const VIDEO_PAUSED_MESSAGE = "Video paused while this tab is inactive";

export function initialVideoSource(digitalReady: boolean | undefined): "camera" | "mirror" {
  return digitalReady === true ? "mirror" : "camera";
}

// Use a local monotonic timestamp, not the customer's wall-clock offset.
export function videoFrameIsUsable(
  visible: boolean,
  receivedAt: number | null,
  now: number,
): boolean {
  return visible && receivedAt !== null && Number.isFinite(receivedAt) &&
    Number.isFinite(now) && now >= receivedAt &&
    now - receivedAt < VIDEO_STALE_AFTER_MS;
}

export function videoPresenceLabel(
  deviceConnected: boolean,
  frameReady: boolean,
  detail: string,
): string {
  if (!deviceConnected) return "Offline";
  if (detail === VIDEO_PAUSED_MESSAGE) return "Paused";
  return frameReady ? "Live" : "Waiting for video";
}
