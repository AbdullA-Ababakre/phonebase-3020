import sharp from "sharp";
import { homeScreenGridVisible, homeScreenLabelCount } from "./fast-vision";
import type { VisionOcrResult } from "./vision-ocr";

/** Conservative detector for the commissioned 720×1560 iPhone switcher.
 * Require an app-card header, card edges, no status clock, and an empty,
 * blurred wallpaper patch below or above the cards. Never infer a safe tap from OCR
 * alone. Other screen sizes/wallpapers may fail closed and need observation. */
export async function appSwitcherDismissPoint(bytes: Buffer, ocr: VisionOcrResult, options: { allowBottom?: boolean } = {}) {
  if (ocr.imageWidth !== 720 || ocr.imageHeight !== 1560 || homeScreenGridVisible(ocr)) return null;
  const confident = ocr.items.filter(item => item.confidence >= 0.7);
  if (confident.some(item => item.centerY < 95 && /\d\s*:\s*\d/.test(item.text))) return null;
  const header = confident.some(item => item.centerY >= 145 && item.centerY <= 225 &&
    item.centerX > 145 && item.centerX < 630 && item.height <= 55 &&
    homeScreenLabelCount({ ...ocr, items: [item] }) === 1);
  if (!header || confident.some(item => item.centerY > 1380)) return null;

  const input = sharp(bytes, { failOn: "error" });
  const metadata = await input.metadata();
  if (metadata.width !== 720 || metadata.height !== 1560) return null;
  const data = await input.resize(180, 390, { fit: "fill" }).removeAlpha()
    .toColourspace("srgb").raw().toBuffer();
  const difference = (x: number, y: number, dx: number, dy: number) => {
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(data[(y * 180 + x) * 3 + c] - data[((y + dy) * 180 + x + dx) * 3 + c]);
    }
    return sum / 3;
  };
  let bottomEdge = 0;
  for (let y = 320; y < 347; y++) {
    let hits = 0;
    for (let x = 27; x < 153; x++) if (difference(x, y, 0, 3) > 25) hits++;
    bottomEdge = Math.max(bottomEdge, hits / 126);
  }
  let sideEdge = 0;
  for (let x = 25; x < 65; x++) {
    let hits = 0;
    for (let y = 110; y < 300; y++) if (difference(x, y, 3, 0) > 20) hits++;
    sideEdge = Math.max(sideEdge, hits / 190);
  }
  let edges = 0;
  let wallpaper = 0;
  let samples = 0;
  // Inspect a larger patch than the touch tip, with a border around the target.
  for (let y = 352; y < 378; y++) {
    for (let x = 72; x < 108; x++) {
      samples++;
      if (difference(x, y, 1, 0) > 15 || difference(x, y, 0, 1) > 15) edges++;
      const offset = (y * 180 + x) * 3;
      const r = data[offset], g = data[offset + 1], b = data[offset + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 18) wallpaper++;
    }
  }
  if (bottomEdge < 0.55 || sideEdge < 0.7) return null;
  if (options.allowBottom !== false && edges / samples <= 0.025 && wallpaper / samples >= 0.7) {
    return { x: 360, y: 1450 };
  }
  // Dark/blurred dock backgrounds can fail the lower-patch test. The area
  // above the recognized card header is another dismiss target, provided a
  // full tip-sized patch is clear wallpaper and contains no OCR text.
  if (confident.some(item => item.left < 440 && item.left + item.width > 280 &&
    item.top < 140 && item.top + item.height > 65)) return null;
  let topEdges = 0, topWallpaper = 0, topSamples = 0;
  for (let y = 18; y < 33; y++) {
    for (let x = 72; x < 108; x++) {
      topSamples++;
      if (difference(x, y, 1, 0) > 15 || difference(x, y, 0, 1) > 15) topEdges++;
      const offset = (y * 180 + x) * 3;
      const channels = [data[offset], data[offset + 1], data[offset + 2]];
      if (Math.max(...channels) - Math.min(...channels) > 18) topWallpaper++;
    }
  }
  if (topEdges / topSamples > 0.025 || topWallpaper / topSamples < 0.7) return null;
  return { x: 360, y: 100 };
}
