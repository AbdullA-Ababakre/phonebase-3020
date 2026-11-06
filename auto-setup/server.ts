import "../shared/station-env.mjs";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import {
  parsePhonebaseCalibrationProfile,
  type PhonebaseCalibrationProfile,
} from "../agent/calibration-profile";
import { registerVisionFrames } from "../agent/vision-register";
import { chooseScreenCandidate, detectVisionScreen } from "../agent/vision-screen";
import {
  autoSetupReferenceIntegrityIssue,
  buildRegisteredAutoSetup,
  buildVisionBaselineProfile,
  calibrationFingerprint,
  profileWithPhoneModelNavigation,
  type AutoSetupReference,
  type AutoSetupRegistration,
} from "./core";

const HOST = process.env.PHONEBASE_AUTO_SETUP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PHONEBASE_AUTO_SETUP_PORT ?? 3031);
const CONTROL_PLANE_URL = new URL(
  process.env.PHONEBASE_CONTROL_PLANE_URL ?? "http://127.0.0.1:3013",
);
const STATE_DIRECTORY = resolve(
  process.env.PHONEBASE_AUTO_SETUP_STATE_DIRECTORY ?? ".runtime/auto-setup",
);
const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const HOME_TIMEOUT_MS = 65_000;
const FRAME_QUALITY_SAMPLE_SIZE = 64;
const MIN_FRAME_LUMA_RANGE = 18;
const MIN_FRAME_LUMA_STANDARD_DEVIATION = 2.5;
const activeDeviceMutations = new Set<string>();

type DeviceSnapshot = {
  id: string;
  connected: boolean;
  state?: {
    cameraReady?: boolean;
    cameraDetail?: string;
    grbl?: {
      connected?: boolean;
      homed?: boolean;
      state?: string;
      activeOperation?: unknown;
      movementBounds?: {
        minimumX?: number;
        maximumX?: number;
        minimumY?: number;
        maximumY?: number;
      };
    };
  };
  screen?: {
    width?: number;
    height?: number;
    rawWidth?: number;
    rawHeight?: number;
    sequence?: number;
    source?: string;
  };
};

type CameraFrame = {
  bytes: Buffer;
  width: number;
  height: number;
  sequence: number;
  sha256: string;
};

type AutoSetupPreview = {
  ok: true;
  status: "model_required" | "ready" | "baseline_required" | "manual_review";
  deviceId: string;
  reason: string;
  homed: boolean;
  phoneModel: PhoneModel | null;
  frame: { width: number; height: number; sequence: number };
  activeImagePoints: PhonebaseCalibrationProfile["imagePoints"] | null;
  proposedImagePoints: PhonebaseCalibrationProfile["imagePoints"] | null;
  referenceCapturedAt: string | null;
  registration: Omit<AutoSetupRegistration, "profile"> | null;
  rectangleProposal?: {
    confidence: number;
    score: number;
    points: PhonebaseCalibrationProfile["imagePoints"];
  } | null;
};

type PhoneModel = {
  id: string;
  label: string;
  detail: string;
  screenAspectRatio: number | null;
};

const PHONE_MODELS: PhoneModel[] = [
  {
    id: "iphone-face-id",
    label: "iPhone X or newer",
    detail: "Face ID models with a tall 19.5:9 display",
    screenAspectRatio: 9 / 19.5,
  },
  {
    id: "iphone-home-button",
    label: "iPhone 6–8 or SE",
    detail: "Home-button models with a 16:9 display",
    screenAspectRatio: 9 / 16,
  },
  {
    id: "android-20-9",
    label: "Android 20:9",
    detail: "Most recent tall Android phones",
    screenAspectRatio: 9 / 20,
  },
  {
    id: "other",
    label: "Other / Custom",
    detail: "Use the verified device profile and keep manual calibration available",
    screenAspectRatio: null,
  },
];

class AutoSetupError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "AUTO_SETUP_ERROR",
  ) {
    super(message);
  }
}

function safeDeviceId(deviceId: string) {
  const safe = deviceId.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe) throw new AutoSetupError("A device ID is required.", 400, "INVALID_DEVICE");
  return safe;
}

function referencePaths(deviceId: string) {
  const safe = safeDeviceId(deviceId);
  return {
    metadata: resolve(STATE_DIRECTORY, `${safe}.json`),
    image: resolve(STATE_DIRECTORY, `${safe}.jpg`),
    model: resolve(STATE_DIRECTORY, `${safe}.model.json`),
  };
}

async function loadPhoneModel(deviceId: string): Promise<PhoneModel | null> {
  try {
    const stored = JSON.parse(
      await readFile(referencePaths(deviceId).model, "utf8"),
    ) as { modelId?: unknown };
    return PHONE_MODELS.find((model) => model.id === stored.modelId) ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function savePhoneModel(deviceId: string, modelIdValue: unknown) {
  const modelId = String(modelIdValue ?? "").trim();
  const model = PHONE_MODELS.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new AutoSetupError("Choose a supported phone model.", 400, "INVALID_PHONE_MODEL");
  }
  const path = referencePaths(deviceId).model;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    version: 1,
    deviceId,
    modelId: model.id,
    selectedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return model;
}

async function withDeviceMutationLock<T>(
  deviceId: string,
  operation: () => Promise<T>,
) {
  if (activeDeviceMutations.has(deviceId)) {
    throw new AutoSetupError(
      "Another automatic setup operation is already running for this device.",
      409,
      "AUTO_SETUP_BUSY",
    );
  }
  activeDeviceMutations.add(deviceId);
  try {
    return await operation();
  } finally {
    activeDeviceMutations.delete(deviceId);
  }
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  payload: unknown,
  status = 200,
) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  const origin = request.headers.origin;
  const allowedOrigin = origin === "http://localhost:3020" ||
      origin === "http://127.0.0.1:3020"
    ? origin
    : "http://127.0.0.1:3020";
  response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Vary", "Origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      throw new AutoSetupError("Request body is too large.", 413, "BODY_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  if (!size) return {} as Record<string, unknown>;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function controlPlaneFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, CONTROL_PLANE_URL), {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  return response;
}

async function controlPlaneJson<T>(path: string, init: RequestInit = {}) {
  const response = await controlPlaneFetch(path, init);
  const payload = await response.json() as T & { error?: string; code?: string };
  if (!response.ok) {
    throw new AutoSetupError(
      payload.error ?? `Control plane returned HTTP ${response.status}.`,
      response.status,
      payload.code ?? "CONTROL_PLANE_ERROR",
    );
  }
  return payload;
}

async function fetchDevice(deviceId: string) {
  const payload = await controlPlaneJson<{ ok: boolean; device: DeviceSnapshot }>(
    `/api/v1/devices/${encodeURIComponent(deviceId)}`,
  );
  const device = payload.device;
  if (!device?.connected) {
    throw new AutoSetupError(
      "The physical Phonebase device is offline.",
      409,
      "DEVICE_NOT_READY",
    );
  }
  if (device.state?.cameraReady !== true) {
    throw new AutoSetupError(
      device.state?.cameraDetail || "A fresh physical camera frame is required.",
      409,
      "CAMERA_NOT_READY",
    );
  }
  if (device.state.grbl?.connected !== true) {
    throw new AutoSetupError(
      "The GRBL controller is offline.",
      409,
      "CONTROLLER_OFFLINE",
    );
  }
  return device;
}

async function fetchCalibration(deviceId: string) {
  const payload = await controlPlaneJson<{
    ok: boolean;
    calibration: { active?: unknown };
  }>(`/api/v1/devices/${encodeURIComponent(deviceId)}/calibration`);
  if (!payload.calibration?.active) {
    throw new AutoSetupError(
      "This station needs one verified four-corner calibration before visual recovery can be enabled.",
      409,
      "CALIBRATION_REQUIRED",
    );
  }
  return parsePhonebaseCalibrationProfile(payload.calibration.active);
}

async function fetchPhysicalFrame(
  deviceId: string,
  requestedSequence?: number,
): Promise<CameraFrame> {
  const sequenceQuery = requestedSequence === undefined
    ? ""
    : `&sequence=${encodeURIComponent(String(requestedSequence))}`;
  const response = await controlPlaneFetch(
    `/api/v1/devices/${encodeURIComponent(deviceId)}/screenshot?source=camera${sequenceQuery}`,
  );
  if (!response.ok) {
    throw new AutoSetupError(
      `A fresh physical camera frame is unavailable (HTTP ${response.status}).`,
      response.status,
      "FRAME_UNAVAILABLE",
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(bytes).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const sequence = Number(response.headers.get("x-phonebase-frame-sequence"));
  if (!width || !height || !Number.isInteger(sequence) || sequence <= 0) {
    throw new AutoSetupError(
      "The physical camera returned incomplete frame metadata.",
      503,
      "FRAME_INVALID",
    );
  }
  return {
    bytes,
    width,
    height,
    sequence,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function requireObservableCameraFrame(frame: CameraFrame) {
  const sample = await sharp(frame.bytes)
    .greyscale()
    .resize(FRAME_QUALITY_SAMPLE_SIZE, FRAME_QUALITY_SAMPLE_SIZE, {
      fit: "fill",
      kernel: "nearest",
    })
    .raw()
    .toBuffer();
  let minimum = 255;
  let maximum = 0;
  let sum = 0;
  let squaredSum = 0;
  for (const luminance of sample) {
    minimum = Math.min(minimum, luminance);
    maximum = Math.max(maximum, luminance);
    sum += luminance;
    squaredSum += luminance * luminance;
  }
  const mean = sum / sample.length;
  const variance = Math.max(0, (squaredSum / sample.length) - (mean * mean));
  const standardDeviation = Math.sqrt(variance);
  if (
    maximum - minimum < MIN_FRAME_LUMA_RANGE ||
    standardDeviation < MIN_FRAME_LUMA_STANDARD_DEVIATION
  ) {
    throw new AutoSetupError(
      "The camera frame is effectively blank. Allow Phonebase Camera access, " +
        "uncover the lens, and light the phone before visual setup.",
      409,
      "CAMERA_FRAME_UNUSABLE",
    );
  }
}

function movementBounds(device: DeviceSnapshot) {
  const bounds = device.state?.grbl?.movementBounds;
  return {
    minimumX: Number(bounds?.minimumX),
    maximumX: Number(bounds?.maximumX),
    minimumY: Number(bounds?.minimumY),
    maximumY: Number(bounds?.maximumY),
  };
}

async function loadReference(deviceId: string) {
  const paths = referencePaths(deviceId);
  try {
    const [metadataText, bytes] = await Promise.all([
      readFile(paths.metadata, "utf8"),
      readFile(paths.image),
    ]);
    const raw = JSON.parse(metadataText) as AutoSetupReference;
    const reference: AutoSetupReference = {
      ...raw,
      calibration: parsePhonebaseCalibrationProfile(raw.calibration),
    };
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const integrityIssue = autoSetupReferenceIntegrityIssue({
      reference,
      expectedDeviceId: deviceId,
      imageSha256: sha256,
    });
    if (integrityIssue) throw new Error(integrityIssue);
    return { reference, bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function saveReference(
  deviceId: string,
  calibration: PhonebaseCalibrationProfile,
  frame: CameraFrame,
) {
  const paths = referencePaths(deviceId);
  const reference: AutoSetupReference = {
    version: 2,
    deviceId,
    calibrationId: calibration.id,
    capturedAt: new Date().toISOString(),
    baselineCalibrationSha256: calibrationFingerprint(calibration),
    authorizedCalibrationSha256: calibrationFingerprint(calibration),
    frame: {
      width: frame.width,
      height: frame.height,
      sequence: frame.sequence,
      sha256: frame.sha256,
    },
    calibration,
  };
  await mkdir(dirname(paths.metadata), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const temporaryMetadata = `${paths.metadata}.${suffix}.tmp`;
  const temporaryImage = `${paths.image}.${suffix}.tmp`;
  await Promise.all([
    writeFile(temporaryMetadata, `${JSON.stringify(reference, null, 2)}\n`, "utf8"),
    writeFile(temporaryImage, frame.bytes),
  ]);
  await rename(temporaryImage, paths.image);
  await rename(temporaryMetadata, paths.metadata);
  return reference;
}

async function authorizeReferenceProfile(
  deviceId: string,
  profile: PhonebaseCalibrationProfile,
) {
  const saved = await loadReference(deviceId);
  if (!saved || saved.reference.calibrationId !== profile.id) {
    throw new AutoSetupError(
      "The trusted camera reference changed before the profile was activated.",
      409,
      "REFERENCE_CHANGED",
    );
  }
  const paths = referencePaths(deviceId);
  const updated: AutoSetupReference = {
    ...saved.reference,
    authorizedCalibrationSha256: calibrationFingerprint(profile),
  };
  const temporaryMetadata = `${paths.metadata}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryMetadata, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  await rename(temporaryMetadata, paths.metadata);
}

async function previewAutoSetup(deviceId: string): Promise<{
  preview: AutoSetupPreview;
  registration: AutoSetupRegistration | null;
}> {
  const [device, profile, frame, phoneModel] = await Promise.all([
    fetchDevice(deviceId),
    fetchCalibration(deviceId).catch((error: unknown) => {
      if (error instanceof AutoSetupError && error.code === "CALIBRATION_REQUIRED") {
        return null;
      }
      throw error;
    }),
    fetchPhysicalFrame(deviceId),
    loadPhoneModel(deviceId),
  ]);
  if (profile && (frame.width !== profile.frame.width || frame.height !== profile.frame.height)) {
    throw new AutoSetupError(
      `Camera resolution ${frame.width}×${frame.height} does not match the saved ` +
        `${profile.frame.width}×${profile.frame.height} profile.`,
      409,
      "CAMERA_RESOLUTION_CHANGED",
    );
  }
  await requireObservableCameraFrame(frame);
  if (!phoneModel) {
    return {
      registration: null,
      preview: {
        ok: true,
        status: "model_required",
        deviceId,
        reason: "Choose the phone model once. Phonebase will remember it for this device.",
        homed: device.state?.grbl?.homed === true,
        phoneModel: null,
        frame: { width: frame.width, height: frame.height, sequence: frame.sequence },
        activeImagePoints: profile?.imagePoints ?? null,
        proposedImagePoints: null,
        referenceCapturedAt: null,
        registration: null,
      },
    };
  }
  if (!profile) {
    return {
      registration: null,
      preview: {
        ok: true,
        status: "baseline_required",
        deviceId,
        reason: "A verified manual four-corner calibration is required before automatic visual recovery can be enabled.",
        homed: device.state?.grbl?.homed === true,
        phoneModel,
        frame: { width: frame.width, height: frame.height, sequence: frame.sequence },
        activeImagePoints: null,
        proposedImagePoints: null,
        referenceCapturedAt: null,
        registration: null,
      },
    };
  }
  const expectedScreenAspectRatio = phoneModel.screenAspectRatio ??
    profile.screen.width / profile.screen.height;
  const saved = await loadReference(deviceId);
  const referenceOutdated = saved !== null && saved.reference.authorizedCalibrationSha256 !== calibrationFingerprint(profile);
  if (!saved || referenceOutdated) {
    const detected = await detectVisionScreen(
      frame.bytes,
      undefined,
      expectedScreenAspectRatio,
    );
    const rectangle = chooseScreenCandidate({
      result: detected,
      expectedPoints: profile.imagePoints,
      expectedScreenAspectRatio,
    }).selected;
    return {
      registration: null,
      preview: {
        ok: true,
        status: "baseline_required",
        deviceId,
        reason: rectangle
          ? (referenceOutdated ? "The previous reference is outdated. A new screen proposal is available; review all four corners before saving." : "A screen proposal is available. Verify the overlay once to save the visual reference.")
          : "The dark screen boundary is ambiguous. Verify the saved corners once; future reconnects will register automatically.",
        homed: device.state?.grbl?.homed === true,
        phoneModel,
        frame: { width: frame.width, height: frame.height, sequence: frame.sequence },
        activeImagePoints: profile.imagePoints,
        proposedImagePoints: rectangle?.points ?? null,
        referenceCapturedAt: null,
        registration: null,
        rectangleProposal: rectangle
          ? {
              confidence: rectangle.confidence,
              score: rectangle.score,
              points: rectangle.points,
            }
          : null,
      },
    };
  }


  try {
    const vision = await registerVisionFrames(saved.bytes, frame.bytes);
    const registered = buildRegisteredAutoSetup({
      reference: saved.reference,
      currentProfile: profile,
      registration: vision,
      movementBounds: movementBounds(device),
    });
    const publicRegistration: Omit<AutoSetupRegistration, "profile"> = {
      imagePoints: registered.imagePoints,
      machinePoints: registered.machinePoints,
      ...(registered.controlMachinePoints
        ? { controlMachinePoints: registered.controlMachinePoints }
        : {}),
      meanDriftPx: registered.meanDriftPx,
      maximumDriftPx: registered.maximumDriftPx,
      confidence: registered.confidence,
      elapsedMs: registered.elapsedMs,
    };
    return {
      registration: registered,
      preview: {
        ok: true,
        status: "ready",
        deviceId,
        reason: registered.maximumDriftPx < 2
          ? "The camera and phone match the saved visual reference."
          : "The phone shift was recovered from the saved camera reference.",
        homed: device.state?.grbl?.homed === true,
        phoneModel,
        frame: { width: frame.width, height: frame.height, sequence: frame.sequence },
        activeImagePoints: profile.imagePoints,
        proposedImagePoints: registered.imagePoints,
        referenceCapturedAt: saved.reference.capturedAt,
        registration: publicRegistration,
      },
    };
  } catch (error) {
    return {
      registration: null,
      preview: {
        ok: true,
        status: "manual_review",
        deviceId,
        reason: error instanceof Error ? error.message : "Visual registration failed.",
        homed: device.state?.grbl?.homed === true,
        phoneModel,
        frame: { width: frame.width, height: frame.height, sequence: frame.sequence },
        activeImagePoints: profile.imagePoints,
        proposedImagePoints: null,
        referenceCapturedAt: saved.reference.capturedAt,
        registration: null,
      },
    };
  }
}

async function activateProfile(
  deviceId: string,
  profile: PhonebaseCalibrationProfile,
) {
  try {
    await controlPlaneJson(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/calibration`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "visual_recovery",
          confirmation: "TRUSTED_CAMERA_REFERENCE_MATCHED",
          profile,
        }),
      },
    );
  } catch (error) {
    const legacyControlPlane = error instanceof AutoSetupError &&
      (
        (
          error.status === 400 &&
          error.code === "INVALID_CALIBRATION" &&
          /Unsupported calibration operation: visual_recovery/.test(error.message)
        ) ||
        (
          error.status === 409 &&
          error.code === "CALIBRATION_NOT_STARTED"
        )
      );
    if (!legacyControlPlane) throw error;

    // The stable :3013 service predates the dedicated visual-recovery route.
    // Its loopback-only recovery endpoint applies the same parsed profile and
    // profile-ID checks; keep this exact fallback until the branch is merged.
    await controlPlaneJson("/api/touch-calibration/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await controlPlaneJson("/api/touch-calibration/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: "TOUCH_PAGE_POINTS_VERIFIED",
        profile,
      }),
    });
  }
  await authorizeReferenceProfile(deviceId, profile);
}

async function waitForHome(deviceId: string, receiptId: string) {
  const deadline = Date.now() + HOME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const payload = await controlPlaneJson<{
      receipt: { status: string; error?: string | null };
    }>(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/actions/${encodeURIComponent(receiptId)}`,
    );
    if (payload.receipt.status === "completed") return;
    if (payload.receipt.status === "failed") {
      throw new AutoSetupError(
        payload.receipt.error ?? "Machine homing failed.",
        409,
        "HOME_FAILED",
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  throw new AutoSetupError("Machine homing timed out.", 504, "HOME_TIMEOUT");
}

async function homeIfRequired(deviceId: string) {
  const device = await fetchDevice(deviceId);
  if (device.state?.grbl?.homed === true) return { performed: false };
  const idempotencyKey = `auto-setup-home-${randomUUID()}`;
  const payload = await controlPlaneJson<{
    result: { receipt?: { id?: string } };
  }>(`/api/v1/devices/${encodeURIComponent(deviceId)}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey,
      action: {
        type: "home",
        confirmation: "CLEAR_WORKSPACE_AND_HOME",
      },
    }),
  });
  const receiptId = payload.result.receipt?.id;
  if (!receiptId) {
    throw new AutoSetupError("The control plane did not return a Home receipt.", 502);
  }
  await waitForHome(deviceId, receiptId);
  return { performed: true, receiptId };
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(request, response, {}, 204);
    return;
  }
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  try {
    if (request.method === "GET" && ["/", "/health"].includes(url.pathname)) {
      sendJson(request, response, {
        ok: true,
        service: "Phonebase vision auto-setup",
        controlPlane: CONTROL_PLANE_URL.origin,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/phone-models") {
      sendJson(request, response, { ok: true, models: PHONE_MODELS });
      return;
    }

    const match = url.pathname.match(
      /^\/v1\/devices\/([^/]+)\/(model|preview|reference|run)$/,
    );
    if (!match || !["GET", "POST"].includes(request.method ?? "")) {
      throw new AutoSetupError("Not found.", 404, "NOT_FOUND");
    }
    const deviceId = decodeURIComponent(match[1]);
    const operation = match[2];
    if (operation === "model" && request.method === "GET") {
      sendJson(request, response, {
        ok: true,
        model: await loadPhoneModel(deviceId),
        models: PHONE_MODELS,
      });
      return;
    }
    if (request.method !== "POST") {
      throw new AutoSetupError("Not found.", 404, "NOT_FOUND");
    }
    const input = await readJson(request);

    if (operation === "model") {
      const model = await withDeviceMutationLock(
        deviceId,
        () => savePhoneModel(deviceId, input.modelId),
      );
      sendJson(request, response, { ok: true, model });
      return;
    }

    if (operation === "preview") {
      const { preview } = await previewAutoSetup(deviceId);
      sendJson(request, response, preview);
      return;
    }

    if (operation === "reference") {
      const reference = await withDeviceMutationLock(deviceId, async () => {
        const adoptVisionProposal = input.adoptVisionProposal === true;
        const expectedConfirmation = adoptVisionProposal
          ? "VISION_PROPOSAL_MATCHES_PHYSICAL_SCREEN"
          : "CURRENT_PLACEMENT_MATCHES_ACTIVE_CALIBRATION";
        if (input.confirmation !== expectedConfirmation) {
          throw new AutoSetupError(
            "Confirm that the displayed corners match the physical screen before saving the visual reference.",
            409,
            "REFERENCE_CONFIRMATION_REQUIRED",
          );
        }
        const requestedSequence = Number(input.frameSequence);
        if (!Number.isInteger(requestedSequence) || requestedSequence <= 0) {
          throw new AutoSetupError(
            "Save reference requires the exact reviewed frame sequence.",
            400,
            "FRAME_SEQUENCE_REQUIRED",
          );
        }
        const [profile, frame, phoneModel] = await Promise.all([
          fetchCalibration(deviceId),
          fetchPhysicalFrame(deviceId, requestedSequence),
          loadPhoneModel(deviceId),
        ]);
        if (!phoneModel) {
          throw new AutoSetupError(
            "Choose the phone model before saving the visual reference.",
            409,
            "PHONE_MODEL_REQUIRED",
          );
        }
        if (requestedSequence !== frame.sequence) {
          throw new AutoSetupError(
            "The camera advanced after the reviewed frame. Preview again before saving.",
            409,
            "STALE_FRAME",
          );
        }
        await requireObservableCameraFrame(frame);
        let referenceProfile = profile;
        if (adoptVisionProposal) {
          const expectedScreenAspectRatio = phoneModel.screenAspectRatio ??
            profile.screen.width / profile.screen.height;
          const detected = await detectVisionScreen(
            frame.bytes,
            undefined,
            expectedScreenAspectRatio,
          );
          const proposal = chooseScreenCandidate({
            result: detected,
            expectedPoints: profile.imagePoints,
            expectedScreenAspectRatio,
          }).selected;
          if (!proposal) {
            throw new AutoSetupError(
              "The reviewed vision proposal is no longer available for this frame.",
              409,
              "VISION_PROPOSAL_UNAVAILABLE",
            );
          }
          referenceProfile = buildVisionBaselineProfile({
            currentProfile: profile,
            imagePoints: proposal.points,
            frame: { width: frame.width, height: frame.height },
          });
        }
        referenceProfile = profileWithPhoneModelNavigation(
          referenceProfile,
          phoneModel.id,
        );
        const saved = await saveReference(deviceId, referenceProfile, frame);
        if (calibrationFingerprint(referenceProfile) !== calibrationFingerprint(profile)) {
          await activateProfile(deviceId, referenceProfile);
        }
        return saved;
      });
      sendJson(request, response, { ok: true, reference }, 201);
      return;
    }

    const dryRun = input.dryRun === true;
    if (!dryRun && input.confirmation !== "CLEAR_WORKSPACE_AND_AUTO_SETUP") {
      throw new AutoSetupError(
        "A clear-workspace confirmation is required before Home.",
        409,
        "WORKSPACE_CONFIRMATION_REQUIRED",
      );
    }
    const executeRun = async () => {
      const initial = await previewAutoSetup(deviceId);
      if (initial.preview.status !== "ready" || !initial.registration) {
        throw new AutoSetupError(initial.preview.reason, 409, "VISUAL_PREFLIGHT_FAILED");
      }
      if (dryRun) {
        return {
          ok: true,
          status: "previewed",
          moved: false,
          profileUpdated: false,
          preview: initial.preview,
        };
      }
      const home = await homeIfRequired(deviceId);
      const settled = await previewAutoSetup(deviceId);
      if (settled.preview.status !== "ready" || !settled.registration) {
        throw new AutoSetupError(
          `Post-Home visual verification failed: ${settled.preview.reason}`,
          409,
          "POST_HOME_VERIFICATION_FAILED",
        );
      }
      await activateProfile(deviceId, settled.registration.profile);
      return {
        ok: true,
        status: "completed",
        moved: home.performed,
        profileUpdated: true,
        home,
        preview: settled.preview,
      };
    };
    const result = dryRun
      ? await executeRun()
      : await withDeviceMutationLock(deviceId, executeRun);
    sendJson(request, response, result);
  } catch (error) {
    const apiError = error instanceof AutoSetupError
      ? error
      : new AutoSetupError(
          error instanceof Error ? error.message : "Unknown auto-setup error.",
          error instanceof SyntaxError ? 400 : 500,
          error instanceof SyntaxError ? "INVALID_JSON" : "AUTO_SETUP_ERROR",
        );
    sendJson(request, response, {
      ok: false,
      error: apiError.message,
      code: apiError.code,
    }, apiError.status);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Phonebase vision auto-setup listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
