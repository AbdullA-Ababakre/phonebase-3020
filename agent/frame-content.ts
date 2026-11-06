import sharp from "sharp";

type NormalizedPoint = { x: number; y: number };

export type FrameContentComparison = {
  matched: boolean;
  score: number;
  globalMeanDifference: number;
  globalChangedRatio: number;
  targetMeanDifference: number | null;
  targetChangedRatio: number | null;
};

const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 128;
const SAMPLE_CHANNELS = 3;
const CHANGED_PIXEL_THRESHOLD = 20;

async function sample(bytes: Buffer) {
  const { data } = await sharp(bytes, { failOn: "error" })
    .resize(SAMPLE_WIDTH, SAMPLE_HEIGHT, { fit: "fill" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

function differenceStats(
  left: Buffer,
  right: Buffer,
  indices: number[],
) {
  let sum = 0;
  let changed = 0;
  for (const index of indices) {
    const difference = Math.abs(left[index] - right[index]);
    sum += difference;
    if (difference >= CHANGED_PIXEL_THRESHOLD) changed += 1;
  }
  return {
    mean: indices.length ? sum / indices.length / 255 : 1,
    changedRatio: indices.length ? changed / indices.length : 1,
  };
}

function allIndices() {
  return Array.from(
    { length: SAMPLE_WIDTH * SAMPLE_HEIGHT * SAMPLE_CHANNELS },
    (_, index) => index,
  );
}

function targetIndices(points: NormalizedPoint[]) {
  const indices = new Set<number>();
  const radiusX = 7;
  const radiusY = 9;
  for (const point of points) {
    const centerX = Math.round(point.x * (SAMPLE_WIDTH - 1));
    const centerY = Math.round(point.y * (SAMPLE_HEIGHT - 1));
    for (let y = centerY - radiusY; y <= centerY + radiusY; y += 1) {
      if (y < 0 || y >= SAMPLE_HEIGHT) continue;
      for (let x = centerX - radiusX; x <= centerX + radiusX; x += 1) {
        if (x < 0 || x >= SAMPLE_WIDTH) continue;
        const base = (y * SAMPLE_WIDTH + x) * SAMPLE_CHANNELS;
        for (let channel = 0; channel < SAMPLE_CHANNELS; channel += 1) {
          indices.add(base + channel);
        }
      }
    }
  }
  return [...indices];
}

function rounded(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Compares an observed frame with the current frame from the same source.
 * Global change catches navigation and dialogs; local change prevents a stale
 * target from being clicked even when the rest of the screen is unchanged.
 */
export async function compareFrameContent(input: {
  observed: Buffer;
  current: Buffer;
  targetPoints?: NormalizedPoint[];
}): Promise<FrameContentComparison> {
  const [observed, current] = await Promise.all([
    sample(input.observed),
    sample(input.current),
  ]);
  const global = differenceStats(observed, current, allIndices());
  const targets = input.targetPoints?.length
    ? differenceStats(observed, current, targetIndices(input.targetPoints))
    : null;
  const globalMatched = global.mean <= 0.045 && global.changedRatio <= 0.16;
  const targetMatched = !targets ||
    (targets.mean <= 0.055 && targets.changedRatio <= 0.18);
  const score = Math.max(0, 1 - (
    global.mean * 4 +
    global.changedRatio * 0.7 +
    (targets ? targets.mean * 2 + targets.changedRatio * 0.5 : 0)
  ));
  return {
    matched: globalMatched && targetMatched,
    score: rounded(score),
    globalMeanDifference: rounded(global.mean),
    globalChangedRatio: rounded(global.changedRatio),
    targetMeanDifference: targets ? rounded(targets.mean) : null,
    targetChangedRatio: targets ? rounded(targets.changedRatio) : null,
  };
}
