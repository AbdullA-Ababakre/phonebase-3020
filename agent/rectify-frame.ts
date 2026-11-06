import sharp from "sharp";

import {
  homographyFromFourPoints,
  type Point,
} from "./homography";
import type { PublicFrameGeometry } from "./frame-geometry";

export type RectifyFrameOptions = {
  rawWidth: number;
  rawHeight: number;
  screenWidth: number;
  screenHeight: number;
  imagePoints: [Point, Point, Point, Point];
  jpegQuality?: number;
};

export type ModelScreenFrame = {
  bytes: Buffer;
  localVisionBytes?: Buffer;
  logicalWidth: number;
  logicalHeight: number;
  imageWidth: number;
  imageHeight: number;
  rectified: boolean;
};

export const DEFAULT_MODEL_LONG_EDGE = 1024;

/**
 * Converts an encoded hardware frame into the phone's canonical screen space,
 * then pre-scales the pixels to the model's known long-edge raster. Midscene
 * still receives the canonical logical size, so its DPR conversion maps model
 * coordinates back into the exact 720x1560 action viewport.
 */
export async function renderModelScreenFrame(
  encodedImage: Buffer,
  geometry: PublicFrameGeometry,
  modelLongEdge = DEFAULT_MODEL_LONG_EDGE,
  localVisionLongEdge?: number,
): Promise<ModelScreenFrame> {
  validateGeometry(geometry);
  if (!Number.isInteger(modelLongEdge) || modelLongEdge < 256 || modelLongEdge > 4096) {
    throw new RangeError("modelLongEdge must be an integer from 256 to 4096.");
  }
  if (
    localVisionLongEdge !== undefined &&
    (!Number.isInteger(localVisionLongEdge) ||
      localVisionLongEdge < 256 ||
      localVisionLongEdge > 4096)
  ) {
    throw new RangeError("localVisionLongEdge must be an integer from 256 to 4096.");
  }

  let canonicalBytes: Buffer;
  if (geometry.rectified) {
    if (!geometry.imagePoints) {
      throw new Error("A rectified frame requires four camera image points.");
    }
    canonicalBytes = await rectifyFrame(encodedImage, {
      rawWidth: geometry.rawWidth,
      rawHeight: geometry.rawHeight,
      screenWidth: geometry.width,
      screenHeight: geometry.height,
      imagePoints: geometry.imagePoints,
    });
  } else if (
    geometry.rawWidth !== geometry.width ||
    geometry.rawHeight !== geometry.height
  ) {
    canonicalBytes = await sharp(encodedImage)
      .resize(geometry.width, geometry.height, { fit: "fill" })
      .jpeg({ quality: 90, chromaSubsampling: "4:2:0" })
      .toBuffer();
  } else {
    canonicalBytes = encodedImage;
  }

  const longEdge = Math.max(geometry.width, geometry.height);
  const scale = Math.min(1, modelLongEdge / longEdge);
  const imageWidth = Math.max(1, Math.round(geometry.width * scale));
  const imageHeight = Math.max(1, Math.round(geometry.height * scale));
  const resizeCanonical = async (targetLongEdge: number) => {
    const targetScale = Math.min(1, targetLongEdge / longEdge);
    if (targetScale >= 1) return canonicalBytes;
    return sharp(canonicalBytes)
      .resize(
        Math.max(1, Math.round(geometry.width * targetScale)),
        Math.max(1, Math.round(geometry.height * targetScale)),
        { fit: "fill" },
      )
      .jpeg({ quality: 90, chromaSubsampling: "4:2:0" })
      .toBuffer();
  };
  const [bytes, localVisionBytes] = await Promise.all([
    resizeCanonical(modelLongEdge),
    localVisionLongEdge === undefined
      ? Promise.resolve(undefined)
      : resizeCanonical(localVisionLongEdge),
  ]);

  return {
    bytes,
    ...(localVisionBytes ? { localVisionBytes } : {}),
    logicalWidth: geometry.width,
    logicalHeight: geometry.height,
    imageWidth,
    imageHeight,
    rectified: geometry.rectified,
  };
}

/**
 * Produces the same canonical phone-screen view as the browser's live canvas,
 * but in Node so the visual model and action executor share one coordinate
 * system. A small bilinear CPU warp is fast enough for the Agent's per-action
 * observation cadence and avoids native OpenCV as an installation dependency.
 */
export async function rectifyFrame(
  encodedImage: Buffer,
  options: RectifyFrameOptions,
): Promise<Buffer> {
  validateOptions(options);
  if (!Buffer.isBuffer(encodedImage) || encodedImage.length === 0) {
    throw new Error("Rectification requires a non-empty encoded image buffer.");
  }

  const decoded = await sharp(encodedImage)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    decoded.info.width !== options.rawWidth ||
    decoded.info.height !== options.rawHeight
  ) {
    throw new Error(
      `Encoded frame is ${decoded.info.width}×${decoded.info.height}, expected ` +
        `${options.rawWidth}×${options.rawHeight}.`,
    );
  }

  const screenCorners: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: options.screenWidth, y: 0 },
    { x: options.screenWidth, y: options.screenHeight },
    { x: 0, y: options.screenHeight },
  ];
  const screenToCamera = homographyFromFourPoints(
    screenCorners,
    options.imagePoints,
  );
  const output = Buffer.alloc(options.screenWidth * options.screenHeight * 3);
  const inputChannels = decoded.info.channels;
  const [a, b, c, d, e, f, g, h, i] = screenToCamera;

  for (let outputY = 0; outputY < options.screenHeight; outputY += 1) {
    for (let outputX = 0; outputX < options.screenWidth; outputX += 1) {
      const denominator = g * outputX + h * outputY + i;
      if (Math.abs(denominator) < 1e-10) continue;
      const inputX = (a * outputX + b * outputY + c) / denominator;
      const inputY = (d * outputX + e * outputY + f) / denominator;
      sampleBilinear(
        decoded.data,
        options.rawWidth,
        options.rawHeight,
        inputChannels,
        inputX,
        inputY,
        output,
        (outputY * options.screenWidth + outputX) * 3,
      );
    }
  }

  return sharp(output, {
    raw: {
      width: options.screenWidth,
      height: options.screenHeight,
      channels: 3,
    },
  })
    .jpeg({ quality: options.jpegQuality ?? 90, chromaSubsampling: "4:2:0" })
    .toBuffer();
}

function sampleBilinear(
  input: Buffer,
  width: number,
  height: number,
  channels: number,
  x: number,
  y: number,
  output: Buffer,
  outputOffset: number,
) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return;
  const left = Math.floor(x);
  const top = Math.floor(y);
  const right = Math.min(width - 1, left + 1);
  const bottom = Math.min(height - 1, top + 1);
  const xWeight = x - left;
  const yWeight = y - top;
  const topLeft = (top * width + left) * channels;
  const topRight = (top * width + right) * channels;
  const bottomLeft = (bottom * width + left) * channels;
  const bottomRight = (bottom * width + right) * channels;

  for (let channel = 0; channel < 3; channel += 1) {
    const upper =
      input[topLeft + channel] * (1 - xWeight) +
      input[topRight + channel] * xWeight;
    const lower =
      input[bottomLeft + channel] * (1 - xWeight) +
      input[bottomRight + channel] * xWeight;
    output[outputOffset + channel] = Math.round(
      upper * (1 - yWeight) + lower * yWeight,
    );
  }
}

function validateOptions(options: RectifyFrameOptions) {
  for (const [name, value] of Object.entries({
    rawWidth: options.rawWidth,
    rawHeight: options.rawHeight,
    screenWidth: options.screenWidth,
    screenHeight: options.screenHeight,
  })) {
    if (!Number.isInteger(value) || value < 32 || value > 4096) {
      throw new RangeError(`${name} must be an integer from 32 to 4096.`);
    }
  }
  if (!Array.isArray(options.imagePoints) || options.imagePoints.length !== 4) {
    throw new RangeError("imagePoints must contain four camera points.");
  }
}

function validateGeometry(geometry: PublicFrameGeometry) {
  for (const [name, value] of Object.entries({
    width: geometry.width,
    height: geometry.height,
    rawWidth: geometry.rawWidth,
    rawHeight: geometry.rawHeight,
  })) {
    if (!Number.isInteger(value) || value < 32 || value > 4096) {
      throw new RangeError(`${name} must be an integer from 32 to 4096.`);
    }
  }
}
