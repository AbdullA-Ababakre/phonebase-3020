import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type Point = { x: number; y: number };
export type CalibrationDraft = {
  deviceId: string;
  frame: { width: number; height: number; sequence: number };
  screen: { width: number; height: number };
  imagePoints: Array<Point | null>;
  machinePoints: Array<Point | null>;
  startedAt: string;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid calibration draft ${label}.`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid calibration draft ${label}.`);
  }
  return value;
}

function points(value: unknown, label: string, bounds?: { width: number; height: number }): Array<Point | null> {
  if (!Array.isArray(value) || value.length !== 4) throw new Error(`Invalid calibration draft ${label}: four entries are required.`);
  return value.map((entry, index) => {
    if (entry === null) return null;
    const point = record(entry, `${label}[${index}]`);
    if (typeof point.x !== "number" || typeof point.y !== "number" ||
        !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error(`Invalid calibration draft ${label}[${index}]: finite XY coordinates are required.`);
    }
    if (bounds && (point.x < 0 || point.x > bounds.width || point.y < 0 || point.y > bounds.height)) {
      throw new Error(`Invalid calibration draft ${label}[${index}]: outside the camera frame.`);
    }
    return { x: point.x, y: point.y };
  });
}

/** Drafts remain unverified work. Loading one never creates an active profile. */
export function parseCalibrationDrafts(value: unknown): Map<string, CalibrationDraft> {
  const snapshot = record(value, "snapshot");
  if (snapshot.version !== 1) throw new Error("Unsupported calibration draft store version.");
  const entries = record(snapshot.drafts, "entries");
  const drafts = new Map<string, CalibrationDraft>();
  for (const [deviceId, raw] of Object.entries(entries)) {
    const draft = record(raw, deviceId);
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(deviceId) || draft.deviceId !== deviceId) {
      throw new Error("Calibration draft key must exactly match its deviceId.");
    }
    if ("verified" in draft || "id" in draft) throw new Error("An active profile cannot be loaded as an unverified calibration draft.");
    const rawFrame = record(draft.frame, `${deviceId}.frame`);
    const frame = {
      width: integer(rawFrame.width, "frame.width", 64, 4096),
      height: integer(rawFrame.height, "frame.height", 64, 4096),
      sequence: integer(rawFrame.sequence, "frame.sequence", 0, Number.MAX_SAFE_INTEGER),
    };
    const rawScreen = record(draft.screen, `${deviceId}.screen`);
    const screen = {
      width: integer(rawScreen.width, "screen.width", 320, 2160),
      height: integer(rawScreen.height, "screen.height", 480, 4096),
    };
    if (typeof draft.startedAt !== "string" || !Number.isFinite(Date.parse(draft.startedAt))) {
      throw new Error("Invalid calibration draft startedAt.");
    }
    drafts.set(deviceId, {
      deviceId, frame, screen,
      imagePoints: points(draft.imagePoints, "imagePoints", frame),
      machinePoints: points(draft.machinePoints, "machinePoints"),
      startedAt: draft.startedAt,
    });
  }
  return drafts;
}

async function atomicWrite(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class CalibrationDraftStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly path: string, private readonly writeSnapshot = atomicWrite) {}

  async load(): Promise<Map<string, CalibrationDraft>> {
    try { return parseCalibrationDrafts(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw new Error(`Calibration drafts could not be loaded; the saved file was preserved. ${error instanceof Error ? error.message : "Invalid draft store."}`);
    }
  }

  save(drafts: ReadonlyMap<string, CalibrationDraft>) {
    // Validate and capture the snapshot before entering the queue, so later
    // in-memory edits cannot alter an already queued durable write.
    const parsed = parseCalibrationDrafts({ version: 1, drafts: Object.fromEntries(drafts) });
    const body = `${JSON.stringify({ version: 1, drafts: Object.fromEntries(parsed) }, null, 2)}\n`;
    const result = this.writes.then(() => this.writeSnapshot(this.path, body));
    this.writes = result.catch(() => undefined);
    return result;
  }
}
