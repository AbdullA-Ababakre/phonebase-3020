import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export type VisionTextItem = {
  text: string;
  confidence: number;
  left: number;
  top: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

export type VisionOcrResult = {
  ok: true;
  imageWidth: number;
  imageHeight: number;
  elapsedMs: number;
  items: VisionTextItem[];
};

export type VisionOcrMode = "fast" | "accurate";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repositoryRoot, "scripts/vision-ocr.swift");
const binaryPath = resolve(repositoryRoot, ".runtime/vision-ocr");
const OCR_MAX_LONG_EDGE = 1_600;
let binaryPromise: Promise<string> | null = null;

export async function recognizeVisionText(
  dataUrl: string,
  signal?: AbortSignal,
  mode: VisionOcrMode = "accurate",
): Promise<VisionOcrResult> {
  if (process.platform !== "darwin") {
    throw new Error("The low-latency Vision OCR path currently requires macOS.");
  }
  const bytes = await prepareOcrImage(decodeImageDataUrl(dataUrl));
  const executable = await ensureVisionOcrBinary(signal);
  const directory = await mkdtemp(resolve(tmpdir(), "phonebase-vision-"));
  const imagePath = resolve(directory, "frame.jpg");
  try {
    await writeFile(imagePath, bytes);
    const stdout = await runFile(executable, [mode, imagePath], signal, 15_000);
    const parsed = JSON.parse(stdout) as Partial<VisionOcrResult>;
    if (
      parsed.ok !== true ||
      !Number.isInteger(parsed.imageWidth) ||
      !Number.isInteger(parsed.imageHeight) ||
      !Array.isArray(parsed.items)
    ) {
      throw new Error("Apple Vision OCR returned an invalid response.");
    }
    return parsed as VisionOcrResult;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function ensureVisionOcrBinary(signal?: AbortSignal) {
  if (!binaryPromise) {
    binaryPromise = (async () => {
      let shouldCompile = false;
      try {
        await access(binaryPath);
        const [source, binary] = await Promise.all([
          stat(sourcePath),
          stat(binaryPath),
        ]);
        shouldCompile = source.mtimeMs > binary.mtimeMs;
      } catch {
        shouldCompile = true;
      }
      if (shouldCompile) {
        await mkdir(dirname(binaryPath), { recursive: true });
        await runFile("/usr/bin/swiftc", [sourcePath, "-O", "-o", binaryPath], signal, 90_000);
      }
      return binaryPath;
    })().catch((error) => {
      binaryPromise = null;
      throw error;
    });
  }
  return binaryPromise;
}

function decodeImageDataUrl(value: string) {
  const match = value.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Vision OCR requires a base64 image data URL.");
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length) throw new Error("Vision OCR received an empty image.");
  return bytes;
}

async function prepareOcrImage(bytes: Buffer) {
  const image = sharp(bytes, { failOn: "error" });
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (Math.max(width, height) <= OCR_MAX_LONG_EDGE) return bytes;
  return image
    .resize({
      width: OCR_MAX_LONG_EDGE,
      height: OCR_MAX_LONG_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

function runFile(
  executable: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeout: number,
) {
  return new Promise<string>((resolveRun, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal, timeout },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(
            `${executable} failed: ${stderr.trim() || error.message}`,
            { cause: error },
          ));
          return;
        }
        resolveRun(stdout);
      },
    );
  });
}
