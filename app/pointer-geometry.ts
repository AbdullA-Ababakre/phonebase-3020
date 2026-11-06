export type ClientRectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ViewportPoint = { x: number; y: number };

/**
 * Maps a browser pointer into a contain-fitted phone viewport.
 *
 * The canvas element can be wider or taller than the pixels actually painted
 * by object-fit: contain. Coordinates in those letterbox/pillarbox bands must
 * not be sent to a physical device.
 */
export function mapContainedClientPoint(
  clientPoint: ViewportPoint,
  bounds: ClientRectLike,
  viewport: { width: number; height: number },
): ViewportPoint | null {
  if (
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null;
  }

  const scale = Math.min(
    bounds.width / viewport.width,
    bounds.height / viewport.height,
  );
  const displayedWidth = viewport.width * scale;
  const displayedHeight = viewport.height * scale;
  const displayedLeft = bounds.left + (bounds.width - displayedWidth) / 2;
  const displayedTop = bounds.top + (bounds.height - displayedHeight) / 2;
  const localX = clientPoint.x - displayedLeft;
  const localY = clientPoint.y - displayedTop;

  if (
    localX < 0 ||
    localX > displayedWidth ||
    localY < 0 ||
    localY > displayedHeight
  ) {
    return null;
  }

  return {
    x: Math.max(0, Math.min(viewport.width, localX / scale)),
    y: Math.max(0, Math.min(viewport.height, localY / scale)),
  };
}

/**
 * Converts a point from the complete raw camera frame into the calibrated
 * phone-screen coordinate space. Points outside the four verified screen
 * corners fail closed so clicks on the fixture never move the arm.
 */
export function mapCameraPointToScreen(
  cameraPoint: ViewportPoint,
  imagePoints: [Point, Point, Point, Point],
  screen: { width: number; height: number },
): ViewportPoint | null {
  if (
    !Number.isFinite(cameraPoint.x) ||
    !Number.isFinite(cameraPoint.y) ||
    !Number.isFinite(screen.width) ||
    !Number.isFinite(screen.height) ||
    screen.width <= 0 ||
    screen.height <= 0
  ) {
    return null;
  }

  try {
    const mapped = projectPoint(
      homographyFromFourPoints(imagePoints, [
        { x: 0, y: 0 },
        { x: screen.width, y: 0 },
        { x: screen.width, y: screen.height },
        { x: 0, y: screen.height },
      ]),
      cameraPoint,
    );
    const epsilon = 1e-6;
    if (
      !Number.isFinite(mapped.x) ||
      !Number.isFinite(mapped.y) ||
      mapped.x < -epsilon ||
      mapped.x > screen.width + epsilon ||
      mapped.y < -epsilon ||
      mapped.y > screen.height + epsilon
    ) {
      return null;
    }
    const x = Math.abs(mapped.x) <= epsilon
      ? 0
      : Math.abs(mapped.x - screen.width) <= epsilon
        ? screen.width
        : mapped.x;
    const y = Math.abs(mapped.y) <= epsilon
      ? 0
      : Math.abs(mapped.y - screen.height) <= epsilon
        ? screen.height
        : mapped.y;
    return {
      x: Math.max(0, Math.min(screen.width, x)),
      y: Math.max(0, Math.min(screen.height, y)),
    };
  } catch {
    return null;
  }
}
import {
  homographyFromFourPoints,
  projectPoint,
  type Point,
} from "../agent/homography";
