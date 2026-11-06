import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { compareFrameContent } from "./frame-content";

async function screen(
  background: string,
  overlays: Array<{ left: number; top: number; width: number; height: number; color: string }> = [],
) {
  let image = sharp({
    create: {
      width: 360,
      height: 780,
      channels: 3,
      background,
    },
  });
  if (overlays.length) {
    image = image.composite(overlays.map((overlay) => ({
      input: {
        create: {
          width: overlay.width,
          height: overlay.height,
          channels: 3,
          background: overlay.color,
        },
      },
      left: overlay.left,
      top: overlay.top,
    })));
  }
  return image.jpeg({ quality: 80 }).toBuffer();
}

test("accepts an unchanged screenshot after re-encoding", async () => {
  const observed = await screen("#f2f2f2", [
    { left: 40, top: 200, width: 280, height: 80, color: "#2277cc" },
  ]);
  const current = await sharp(observed).jpeg({ quality: 70 }).toBuffer();
  const result = await compareFrameContent({
    observed,
    current,
    targetPoints: [{ x: 0.5, y: 0.31 }],
  });
  assert.equal(result.matched, true);
  assert.ok(result.score > 0.9);
});

test("rejects navigation to a different screen", async () => {
  const observed = await screen("#f2f2f2", [
    { left: 40, top: 200, width: 280, height: 80, color: "#2277cc" },
  ]);
  const current = await screen("#222222", [
    { left: 20, top: 80, width: 320, height: 500, color: "#dd5533" },
  ]);
  const result = await compareFrameContent({ observed, current });
  assert.equal(result.matched, false);
  assert.ok(result.globalChangedRatio > 0.2);
});

test("rejects a changed tap target even when the rest of the screen is stable", async () => {
  const observed = await screen("#f2f2f2", [
    { left: 135, top: 340, width: 90, height: 70, color: "#2277cc" },
  ]);
  const current = await screen("#f2f2f2", [
    { left: 135, top: 340, width: 90, height: 70, color: "#dd3322" },
  ]);
  const result = await compareFrameContent({
    observed,
    current,
    targetPoints: [{ x: 0.5, y: 0.48 }],
  });
  assert.equal(result.matched, false);
  assert.ok(result.targetChangedRatio !== null && result.targetChangedRatio > 0.18);
});
