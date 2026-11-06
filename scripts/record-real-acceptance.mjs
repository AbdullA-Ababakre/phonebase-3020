import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.PHONEBASE_CONTROL_PLANE_URL ??
  "http://127.0.0.1:3013";
const runId = process.env.PHONEBASE_ACCEPTANCE_RUN_ID ?? "";
const runStartedAt = Number(process.env.PHONEBASE_ACCEPTANCE_STARTED_AT ?? 0);
if (!runId || !Number.isSafeInteger(runStartedAt) || runStartedAt <= 0 || runStartedAt > Date.now()) {
  throw new Error("Provide this run's PHONEBASE_ACCEPTANCE_RUN_ID and PHONEBASE_ACCEPTANCE_STARTED_AT; historical actions cannot pass acceptance.");
}
const requestedDeviceId = process.env.PHONEBASE_DEVICE_ID ?? "";
const sampleDurationMs = Number(
  process.env.PHONEBASE_ACCEPTANCE_SAMPLE_MS ?? 5_000,
);

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status}: ${payload.error ?? "request failed"}`);
  }
  return payload;
}

const devices = (await get("/api/v1/devices")).devices ?? [];
const candidates = devices.filter((device) => device.connected);
const device = requestedDeviceId
  ? candidates.find((candidate) => candidate.id === requestedDeviceId)
  : candidates.length === 1
    ? candidates[0]
    : null;
if (!device) {
  throw new Error(
    requestedDeviceId
      ? `Connected Phonebase device not found: ${requestedDeviceId}`
      : `Exactly one connected Phonebase device is required; found ${candidates.length}`,
  );
}

const encodedDeviceId = encodeURIComponent(device.id);
const calibration = (await get(
  `/api/v1/devices/${encodedDeviceId}/calibration`,
)).calibration;
const allReceipts = (await get(
  `/api/v1/devices/${encodedDeviceId}/actions`,
)).receipts ?? [];

const receipts = allReceipts.filter(receipt => receipt.createdAt >= runStartedAt && receipt.idempotencyKey?.startsWith(runId + ":"));
const precisionPath = process.env.PHONEBASE_ACCEPTANCE_PRECISION_REPORT;
const precision = precisionPath ? JSON.parse(await readFile(precisionPath, "utf8")) : null;
const samples = [];
const observedSequences = new Set();
const samplingStartedAt = Date.now();
while (Date.now() - samplingStartedAt < sampleDurationMs) {
  const current = (await get(
    `/api/v1/devices/${encodedDeviceId}`,
  )).device;
  const screen = current.screen;
  if (screen && !observedSequences.has(screen.sequence)) {
    observedSequences.add(screen.sequence);
    samples.push({
      sequence: screen.sequence,
      capturedAt: screen.capturedAt,
      observedAt: Date.now(),
      ageMs: Math.max(0, Date.now() - screen.capturedAt),
    });
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
}

const camera = (await get(`/api/v1/devices/${encodedDeviceId}?source=camera`)).device?.screen;
const cameraAgeMs = camera ? Date.now() - camera.capturedAt : Number.POSITIVE_INFINITY;
const sampleSpanMs = samples.length > 1
  ? samples.at(-1).observedAt - samples[0].observedAt
  : 0;
const observedFps = sampleSpanMs > 0
  ? ((samples.length - 1) * 1_000) / sampleSpanMs
  : 0;
const averageFrameAgeMs = samples.length
  ? samples.reduce((sum, sample) => sum + sample.ageMs, 0) / samples.length
  : Number.POSITIVE_INFINITY;
const completedTypes = new Set(
  receipts
    .filter((receipt) => receipt.status === "completed")
    .map((receipt) => receipt.actionType),
);
const grbl = device.state?.grbl ?? {};
const activeProfile = calibration?.active ?? null;

const requirements = {
  nodeVersion: {
    pass: device.state?.appVersion === "0.1.14",
    actual: device.state?.appVersion ?? null,
    expected: "0.1.14",
  },
  videoSources: {
    pass: device.screen?.source === "iphone-wired-usb-video" && camera?.role === "verification" && cameraAgeMs >= 0 && cameraAgeMs < 2000,
    hdMirror: device.screen?.source ?? null,
    camera: camera?.role ?? null,
    cameraAgeMs: Number.isFinite(cameraAgeMs) ? cameraAgeMs : null,
  },
  physicalAccuracy: {
    pass: precision?.runId === runId && precision?.deviceId === device.id &&
      Date.parse(precision?.createdAt ?? "") >= runStartedAt &&
      precision?.measurements?.length >= 25 && precision?.summary?.maximumErrorPx <= 15 &&
      precision.measurements.every(value => Number.isFinite(value.error?.distance) && value.error.distance <= 15),
    reportPath: precisionPath ?? null,
    maximumErrorPx: precision?.summary?.maximumErrorPx ?? null,
  },
  liveFrameRate: {
    pass: observedFps >= 4,
    observedFps: Number(observedFps.toFixed(2)),
    uniqueFrames: samples.length,
    sampleDurationMs,
  },
  liveFrameAge: {
    pass: averageFrameAgeMs <= 1_500,
    averageFrameAgeMs: Number.isFinite(averageFrameAgeMs)
      ? Math.round(averageFrameAgeMs)
      : null,
    maximumFrameAgeMs: samples.length
      ? Math.max(...samples.map((sample) => sample.ageMs))
      : null,
  },
  hardwareOnline: {
    pass: grbl.connected === true,
    state: grbl.state ?? null,
    position: {
      x: grbl.x ?? null,
      y: grbl.y ?? null,
      z: grbl.z ?? null,
    },
  },
  verifiedCalibration: {
    pass: activeProfile?.verified === true && activeProfile?.deviceId === device.id,
    profileId: activeProfile?.id ?? null,
    verifiedAt: activeProfile?.verifiedAt ?? null,
  },
  tap: { pass: completedTypes.has("tap") },
  longPress: { pass: completedTypes.has("long_press") },
  swipe: { pass: completedTypes.has("swipe") },
  emergencyHold: { pass: completedTypes.has("hold") },
  noUnresolvedFailures: {
    pass: !receipts.some((receipt) => receipt.status === "failed"),
    failedReceiptIds: receipts
      .filter((receipt) => receipt.status === "failed")
      .map((receipt) => receipt.id),
  },
};

const passed = Object.values(requirements).every(
  (requirement) => requirement.pass === true,
);
const recordedAt = new Date();
const report = {
  schema: "phonebase-real-acceptance/v2",
  runId,
  runStartedAt,
  recordedAt: recordedAt.toISOString(),
  passed,
  deviceId: device.id,
  requirements,
  evidence: {
    device,
    calibration,
    receipts,
    frameSamples: samples,
  },
};
const outputDirectory = resolve("build/acceptance");
const outputName = recordedAt.toISOString().replaceAll(":", "-") + ".json";
const outputPath = resolve(outputDirectory, outputName);
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  passed,
  deviceId: device.id,
  outputPath,
  requirements,
}, null, 2)}\n`);
if (!passed) process.exitCode = 2;
