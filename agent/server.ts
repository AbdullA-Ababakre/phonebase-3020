import { readFileSync } from "node:fs";
import { cameraPolicy, selectCameraCaptures, configurationWithCameraFocus, type FleetCameraConfiguration } from "../bridge/camera-selection";
import { FleetConfigurationBusyError, updateFleetConfiguration } from "../bridge/fleet-configuration-store";
import { readFleetDiscoveryView } from "./fleet-discovery-status";
import "../shared/station-env.mjs";
import { ObservabilityClient } from "./observability-client";
import { PublishingService } from "./publishing";
import { actionConfirmation, actionDetails, clientSource, requestIdentity } from "./observability";
import { traceTrialStage } from "./trial-trace";
import { SHORT_CODE_GATEWAY } from "../shared/short-access-code.mjs";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import sharp from "sharp";
import {
  buildPhonebaseCapabilities,
  normalizePhonebasePoint,
  parsePhonebaseActionEnvelope,
  PHONEBASE_TAP_DEFAULT_DURATION_MS,
  PHONEBASE_TAP_MAX_DURATION_MS,
  PHONEBASE_TAP_MIN_DURATION_MS,
  PhonebaseActionValidationError,
  type PhonebaseSemanticAction,
} from "./action-contract";
import {
  calibratedScreenPoint,
  calibrationReadiness,
  loadPhonebaseCalibrationProfile,
  parsePhonebaseCalibrationProfile,
  type PhonebaseCalibrationProfile,
} from "./calibration-profile";
import { frameGeometryFor, framePointToScreenPoint } from "./frame-geometry";
import { homographyFromFourPoints, projectPoint } from "./homography";
import { iosEnglishKeyboardSequence, iosKeyboardInitialShift, iosPhoneKeypadSequence, iosKeyboardGeometryFromOcr, IOS_ENGLISH_SUPPORTED_CHARACTERS } from "./ios-keyboard";
import { iosEnglishKeyboardVisible } from "./ios-keyboard-visibility";
import { evaluateScreenExpectation, visibleAccessBlockers, type ScreenExpectation } from "./screen-postcondition";
import {
  locateVisibleTextMatches,
  looksLikeIosPhoneKeypad,
  looksLikeIosKeyboard,
  visibleMessageDeliveryFailure,
} from "./fast-intent";
import { weatherSettingsCancel } from "./weather-home";
import { appLibraryVisible, homeScreenGridVisible, locateHomeApp, ocrTextSample } from "./fast-vision";
import { runPhoneHomeWorkflow, waitForPhoneHomeReadiness } from "./phone-home-workflow";
import { appSwitcherDismissPoint } from "./app-switcher";
import { visibleInsetBackPoint } from "./back-navigation";
import { recognizeVisionText } from "./vision-ocr";
import {
  parsePhonebaseVisualActionEnvelope,
  PhonebaseVisualActionValidationError,
  type PhonebaseVisualActionEnvelope,
} from "./visual-action";
import { renderModelScreenFrame } from "./rectify-frame";
import {
  compactHoverReceiptOperation,
  commandResultReceiptDecision,
  operationReceiptDecision,
  receiptIdsToPrune,
} from "./receipt-state";
import { comparePhoneFramesBackground } from "./frame-sync-background";
import { compareFrameContent } from "./frame-content";
import {
  buildJevLocateRequest,
  OPENROUTER_DECISIONS_URL,
  OPENROUTER_JEV_MODEL,
  parseJevLocateResponse,
  qualifyJevActionCandidate,
} from "./openrouter-jev";
import {
  buildPhoneAgentRequest,
  DEFAULT_PHONE_AGENT_MODEL,
  OPENROUTER_CHAT_URL,
  parsePhoneAgentResponse,
  type PhoneAgentAction,
} from "./openrouter-phone-agent";
import {
  buildPhoneKeyCommand,
  recoverableAgentExecutionFeedback,
} from "./phone-key-execution";
import {
  RecorderStore,
  type RecordedAction,
  type RecorderWorkflow,
} from "./recorder-store";
import { calibrationReadinessIssue } from "../shared/calibration-readiness";
import {
  assertCalibrationFrame, assertCalibrationStatus, assertMachinePointCapture,
  ManualCalibrationError, waitForCalibrationJog,
} from "./manual-calibration";
import { CalibrationDraftStore, type CalibrationDraft } from "./calibration-draft-store";
import { createPhonebaseAccessCode } from "../shared/connection-code.mjs";
import {
  createRentalLease,
  createRentalLeaseToken,
  createRentalShortCode,
  readRentalLeaseRegistry,
  renewRentalLease,
  rentalLeaseActive,
  revokeRentalLease,
  writeRentalLeaseRegistry,
  type RentalLease,
} from "../shared/rental-leases.mjs";

const HOST = process.env.PHONEBASE_CONTROL_PLANE_HOST ?? "127.0.0.1";
const PORT = Number(
  process.env.PHONEBASE_CONTROL_PLANE_PORT ?? 3013,
);
const MAX_BODY_BYTES = 14 * 1024 * 1024;
const FRAME_FRESHNESS_MS = 15_000;
const ACTION_FRAME_FRESHNESS_MS = FRAME_FRESHNESS_MS;
const ACTION_FRAME_MAX_AGE_MS = 60_000;
const MAX_RETAINED_ACTION_FRAMES = 64;
const CONTROL_FRAME_FALLBACK_MS = 2_500;
const FRAME_SYNC_CHECK_INTERVAL_MS = 900;
const FRAME_SYNC_FRESHNESS_MS = 3_000;
// Real camera glare lowers correlation even when the UI is identical. The
// verified mismatch sample scored 0.493; the same dialer with the arm parked
// scores about 0.555, so keep a conservative gap and require two matches.
const FRAME_SYNC_THRESHOLD = 0.54;
// Content correlation is useful telemetry, but the fixed camera can produce
// false mismatches on bright, low-detail screens. The verified calibration,
// fresh physical camera and hardware bounds remain hard gates; correlation is
// advisory unless an installation explicitly opts into strict enforcement.
const FRAME_SYNC_ENFORCED = process.env.PHONEBASE_FRAME_SYNC_ENFORCED === "1";
const TOUCH_CALIBRATION_HEARTBEAT_MS = 2_500;
const MAX_DEVICE_CLOCK_SKEW_MS = 60_000;
const PHONEBASE_PROTOCOL_VERSION = "2026-07-29";
const TOUCH_CALIBRATION_PAGE_URL = new URL(
  "../public/touch-calibration.html",
  import.meta.url,
);
const OPENAPI_URL = new URL("../public/openapi.json", import.meta.url);
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3020",
  "http://127.0.0.1:3020",
  "http://[::1]:3020",
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const REMOTE_CONTROL_ENABLED = process.env.PHONEBASE_CONTROL_PLANE_ALLOW_REMOTE === "1";
const CONTROL_PLANE_TOKEN = process.env.PHONEBASE_CONTROL_PLANE_TOKEN?.trim() ?? "";
const ACTION_RECEIPTS_PATH = resolve(
  process.env.PHONEBASE_ACTION_RECEIPTS_PATH ?? "build/runtime/action-receipts.json",
);
const AUDIT_LOG_PATH = resolve(
  process.env.PHONEBASE_AUDIT_LOG_PATH ?? "build/runtime/audit.jsonl",
);
const observability = new ObservabilityClient(process.env.PHONEBASE_OBSERVABILITY_PATH ?? resolve(dirname(AUDIT_LOG_PATH), "observability.sqlite"));
const RENTAL_LEASES_PATH = resolve(
  process.env.PHONEBASE_RENTAL_LEASES_PATH ?? ".runtime/rental-leases.json",
);
const RECORDER_PATH = resolve(
  process.env.PHONEBASE_RECORDER_PATH ?? ".runtime/recorder-workflows.json",
);
const OPENROUTER_KEY_PATH = resolve(
  process.env.PHONEBASE_OPENROUTER_KEY_PATH ?? ".runtime/openrouter.key",
);
const PHONE_AGENT_MODEL = process.env.PHONEBASE_AGENT_MODEL?.trim() ||
  DEFAULT_PHONE_AGENT_MODEL;
const PHONE_AGENT_BUDGET_USD = Number(process.env.PHONEBASE_AGENT_BUDGET_USD ?? "0.50");
const PHONE_AGENT_MAX_STEPS = Number(process.env.PHONEBASE_AGENT_MAX_STEPS ?? "36");
const recorder = new RecorderStore(RECORDER_PATH);
const recorderBusyDevices = new Set<string>();
type AgentTaskStep = {
  index: number;
  at: number;
  summary: string;
  action: PhoneAgentAction;
  outcome: string;
  latencyMs: number;
  cost: number;
  locator?: {
    model: string;
    provider: string;
    target: string;
    frameSequence: number;
    visibleProbability: number;
    confidence: number;
    box: { top: number; bottom: number; left: number; right: number };
    plannerAgreement: boolean;
    qualifiedBy: "jev" | "planner+jev" | null;
    boxArea: number;
    latencyMs: number;
    cost: number;
  };
};
type AgentTask = {
  id: string;
  deviceId: string;
  goal: string;
  status: "running" | "succeeded" | "blocked" | "failed" | "stopped";
  createdAt: number;
  updatedAt: number;
  model: string;
  maxSteps: number;
  budgetUsd: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  steps: AgentTaskStep[];
  summary: string;
  error: string;
  stopRequested: boolean;
};
const agentTasks = new Map<string, AgentTask>();
const agentBusyDevices = new Set<string>();
const phoneHomeJobs = new Map<string, { id: string; cancelled: boolean }>();
const CLOUD_CONSOLE_URL = process.env.PHONEBASE_CLOUD_CONSOLE_URL?.trim() ||
  "https://phoneuse.com/console";

if (!LOOPBACK_HOSTS.has(HOST)) {
  if (!REMOTE_CONTROL_ENABLED || CONTROL_PLANE_TOKEN.length < 32) {
    throw new Error(
      "Non-loopback control-plane binding requires PHONEBASE_CONTROL_PLANE_ALLOW_REMOTE=1 and a PHONEBASE_CONTROL_PLANE_TOKEN of at least 32 characters.",
    );
  }
}

let calibrationProfile = loadPhonebaseCalibrationProfile();
const calibrationProfiles = new Map<string, NonNullable<typeof calibrationProfile>>();
if (calibrationProfile) {
  calibrationProfiles.set(calibrationProfile.deviceId, calibrationProfile);
}
const CALIBRATION_OUTPUT_PATH = resolve(
  process.env.PHONEBASE_CALIBRATION_OUTPUT_PATH ??
    "build/runtime/black-arm-calibration.json",
);
const CALIBRATION_DIRECTORY = process.env.PHONEBASE_CALIBRATION_DIRECTORY
  ? resolve(process.env.PHONEBASE_CALIBRATION_DIRECTORY)
  : null;

if (CALIBRATION_DIRECTORY) {
  try {
    for (const entry of await readdir(CALIBRATION_DIRECTORY, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const profile = parsePhonebaseCalibrationProfile(JSON.parse(
          await readFile(resolve(CALIBRATION_DIRECTORY, entry.name), "utf8"),
        ));
        calibrationProfiles.set(profile.deviceId, profile);
      } catch (error) {
        console.warn(`Ignoring invalid calibration ${entry.name}: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function calibrationOutputPath(deviceId: string) {
  if (!CALIBRATION_DIRECTORY) return CALIBRATION_OUTPUT_PATH;
  const safeId = deviceId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return resolve(CALIBRATION_DIRECTORY, `${safeId}.json`);
}

type ScreenFrame = {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
  source: string;
  deviceId?: string;
  role?: "control" | "verification";
};

type StoredFrame = {
  frame: ScreenFrame;
  sequence: number;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Buffer;
};

type DeviceFrameRuntime = {
  latestFrame: StoredFrame | null;
  latestControlFrame: StoredFrame | null;
  latestVerificationFrame: StoredFrame | null;
  frameSyncCheckRunning: boolean;
  frameSyncLastCheckedAt: number;
  frameSyncMatchStreak: number;
  frameSyncState: {
    status: "checking" | "synchronized" | "mismatch" | "camera_fallback";
    score: number | null;
    checkedAt: number | null;
    detail: string;
  };
};

type NodeCommand = {
  action:
    | "status"
    | "hold"
    | "home"
    | "resume"
    | "jog"
    | "hover_move"
    | "tap"
    | "long_press"
    | "swipe"
    | "input_text";
  params?: {
    axis?: string;
    distance?: number;
    feed?: number;
    x?: number;
    y?: number;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    durationMs?: number;
    touchZ?: number;
    points?: Array<{ x: number; y: number }>;
    profileId?: string;
    mode?: "calibration";
  };
};

type RemoteNode = {
  deviceId: string;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  lastStateAt: number;
  state: unknown;
  lastEvent: unknown;
};


type TouchCalibrationSample = {
  id: number;
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
  viewportWidth: number;
  viewportHeight: number;
  screenX: number;
  screenY: number;
  screenWidth: number;
  screenHeight: number;
  normalizedScreenX: number;
  normalizedScreenY: number;
  coordinateSpaceVersion: 2;
  pointerType: string;
  capturedAt: number;
};

type ActionReceipt = {
  id: string;
  deviceId: string;
  idempotencyKey: string;
  actionType: PhonebaseSemanticAction["type"];
  actionFingerprint?: string;
  source?: string;
  status: "accepted" | "executing" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  error: string | null;
  result: unknown;
  actor: string;
  requestId: string;
};

type ActionRequestContext = {
  /** Internal semantic-to-primitive delegation; never accepted from a client. */
  receiptActionType?: PhonebaseSemanticAction["type"];
  /** Internal only; never populated from request headers or body. */
  homeWorkflowId?: string;
  actionFingerprint?: string;
  source?: string;
  actor: string;
  requestId: string;
};

let latestFrame: StoredFrame | null = null;
let latestVerificationFrame: StoredFrame | null = null;
const deviceFrameRuntimes = new Map<string, DeviceFrameRuntime>();
const recentFrames = new Map<number, StoredFrame>();
const retainedActionFrames = new Map<number, StoredFrame>();
const remoteNodes = new Map<string, RemoteNode>();
const liveSubscribers = new Set<{
  socket: WebSocket;
  deviceId: string;
  raw: boolean;
}>();
// Time-based IDs prevent an old client frame from aliasing a new frame after restart.
let frameSequence = Date.now() * 1000;
const calibrationDraftStore = new CalibrationDraftStore(resolve(
  process.env.PHONEBASE_CALIBRATION_DRAFTS_PATH ?? "build/runtime/calibration-drafts.json",
));
const calibrationDrafts = await calibrationDraftStore.load();
let calibrationDraftWriteQueue: Promise<void> = Promise.resolve();
type CalibrationJog = { id: string; status: "executing" | "completed" | "failed" | "unconfirmed"; target?: { x: number; y: number }; error?: string };
const calibrationJogs = new Map<string, CalibrationJog>();
const touchCalibrationSamples: TouchCalibrationSample[] = [];
let touchCalibrationSampleId = 0;
let touchCalibrationHeartbeatAt = 0;
const actionReceipts = new Map<string, ActionReceipt>();
const actionReceiptIdsByKey = new Map<string, string>();
const MAX_ACTION_RECEIPTS_PER_DEVICE = 512;
const MAX_ACTION_RECEIPTS = 2_048;
let receiptWriteQueue = Promise.resolve();
let auditWriteQueue = Promise.resolve();

function deviceFrameRuntime(deviceId: string): DeviceFrameRuntime {
  const key = deviceId.trim() || "unassigned-camera";
  const existing = deviceFrameRuntimes.get(key);
  if (existing) return existing;
  const created: DeviceFrameRuntime = {
    latestFrame: null,
    latestControlFrame: null,
    latestVerificationFrame: null,
    frameSyncCheckRunning: false,
    frameSyncLastCheckedAt: 0,
    frameSyncMatchStreak: 0,
    frameSyncState: {
      status: "checking",
      score: null,
      checkedAt: null,
      detail: "Waiting to compare the wired screen with the physical phone",
    },
  };
  deviceFrameRuntimes.set(key, created);
  return created;
}

function existingDeviceFrameRuntime(deviceId: string) {
  return deviceFrameRuntimes.get(deviceId.trim() || "unassigned-camera") ?? null;
}

function calibrationProfileFor(deviceId: string) {
  const profile = calibrationProfiles.get(deviceId) ?? null;
  if (!profile) return null;
  const geometryIssue = calibrationReadinessIssue({
    imagePoints: profile.imagePoints,
    machinePoints: profile.controlMachinePoints ?? profile.machinePoints,
  });
  return geometryIssue ? null : profile;
}

class PhonebaseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

function corsOrigin(request: IncomingMessage): string {
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  return "http://localhost:3020";
}

function setHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  status = 200,
  contentType = "application/json; charset=utf-8",
) {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Access-Control-Allow-Origin", corsOrigin(request));
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Request-Id, X-Phonebase-Actor, X-Phonebase-Client",
  );
  response.setHeader("Access-Control-Max-Age", "600");
  response.setHeader("Access-Control-Expose-Headers", "X-Request-Id, Server-Timing");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Vary", "Origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "X-Request-Id",
    boundedHeader(request.headers["x-request-id"], randomUUID(), 160),
  );
}

function requestIsAuthorized(request: IncomingMessage) {
  if (LOOPBACK_HOSTS.has(HOST)) return true;
  return request.headers.authorization === `Bearer ${CONTROL_PLANE_TOKEN}`;
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  payload: unknown,
  status = 200,
) {
  setHeaders(request, response, status);
  const data = objectValue(payload);
  if (data.code) response.setHeader("X-Phonebase-Error-Code", String(data.code));
  response.end(JSON.stringify(payload));
}

async function readBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Frame data exceeds 14 MB. Reduce the camera resolution.");
    }
    chunks.push(bytes);
  }

  return Buffer.concat(chunks);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const bytes = await readBytes(request);
  if (!bytes.length) return {} as T;
  return JSON.parse(bytes.toString("utf8")) as T;
}

function validateFrame(frame: Partial<ScreenFrame>): ScreenFrame {
  if (
    typeof frame.dataUrl !== "string" ||
    !/^data:image\/(jpeg|png|webp);base64,/.test(frame.dataUrl)
  ) {
    throw new Error("Only JPEG, PNG, or WebP camera frames are accepted.");
  }
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    Number(frame.width) < 64 ||
    Number(frame.height) < 64 ||
    Number(frame.width) > 4096 ||
    Number(frame.height) > 4096
  ) {
    throw new Error("The frame dimensions are invalid.");
  }

  const receivedAt = Date.now();
  const deviceCapturedAt = Number(frame.capturedAt);
  const capturedAt =
    Number.isFinite(deviceCapturedAt) &&
    Math.abs(receivedAt - deviceCapturedAt) <= MAX_DEVICE_CLOCK_SKEW_MS
      ? deviceCapturedAt
      : receivedAt;

  return {
    dataUrl: frame.dataUrl,
    width: Math.round(Number(frame.width)),
    height: Math.round(Number(frame.height)),
    capturedAt,
    source:
      typeof frame.source === "string" && frame.source.trim()
        ? frame.source.trim().slice(0, 80)
        : "browser-camera",
    deviceId:
      typeof frame.deviceId === "string" && frame.deviceId.trim()
        ? frame.deviceId.trim().slice(0, 120)
        : undefined,
    role: frame.role === "verification" ? "verification" : "control",
  };
}

function frameGeometry(stored: StoredFrame | null) {
  if (!stored) return null;
  const profile = stored.frame.deviceId
    ? calibrationProfileFor(stored.frame.deviceId)
    : null;
  return frameGeometryFor(stored.frame, profile);
}

function publicFrame(stored: StoredFrame | null) {
  if (!stored) return null;
  const geometry = frameGeometry(stored);
  return {
    ...geometry,
    capturedAt: stored.frame.capturedAt,
    source: stored.frame.source,
    role: stored.frame.role ?? "control",
    sequence: stored.sequence,
    deviceId: stored.frame.deviceId,
  };
}

function liveFrameMetadata(stored: StoredFrame, raw = false) {
  const publicValue = raw
    ? {
        width: stored.frame.width,
        height: stored.frame.height,
        rawWidth: stored.frame.width,
        rawHeight: stored.frame.height,
        rectified: false,
        imagePoints: null,
        calibrationId: null,
        capturedAt: stored.frame.capturedAt,
        source: stored.frame.source,
        role: stored.frame.role ?? "control",
        sequence: stored.sequence,
        deviceId: stored.frame.deviceId,
      }
    : publicFrame(stored);
  return {
    type: "frame",
    ...publicValue,
    mimeType: stored.mimeType,
    byteLength: stored.bytes.length,
  };
}

function sendLiveFrame(socket: WebSocket, stored: StoredFrame, raw = false) {
  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 2_000_000) {
    return;
  }
  // Setup and calibration must see the physical verification frame exactly as
  // the camera captured it. The normal device wall keeps the rectified screen.
  socket.send(JSON.stringify(liveFrameMetadata(stored, raw)));
  socket.send(stored.bytes);
}

function broadcastLiveFrame(
  stored: StoredFrame,
  audience: "control" | "verification",
) {
  for (const subscriber of liveSubscribers) {
    if (
      subscriber.deviceId &&
      subscriber.deviceId !== stored.frame.deviceId
    ) {
      continue;
    }
    if ((audience === "verification") !== subscriber.raw) continue;
    sendLiveFrame(subscriber.socket, stored, subscriber.raw);
  }
}

function storeFrame(
  frame: ScreenFrame,
  mimeType: StoredFrame["mimeType"],
  bytes: Buffer,
) {
  frameSequence = Math.max(frameSequence + 1, Date.now() * 1000);
  const stored: StoredFrame = {
    frame,
    sequence: frameSequence,
    mimeType,
    bytes,
  };
  const runtime = deviceFrameRuntime(frame.deviceId ?? "");
  if (frame.role === "verification") {
    runtime.latestVerificationFrame = stored;
    latestVerificationFrame = stored;
    broadcastLiveFrame(stored, "verification");
    if (!frameIsFresh(runtime.latestControlFrame, CONTROL_FRAME_FALLBACK_MS)) {
      runtime.latestFrame = stored;
      latestFrame = stored;
      broadcastLiveFrame(stored, "control");
    }
  } else {
    runtime.latestControlFrame = stored;
    runtime.latestFrame = stored;
    latestFrame = stored;
    broadcastLiveFrame(stored, "control");
  }
  recentFrames.set(frameSequence, stored);
  // Keep enough recent frames for a user to see a rendered frame and click it
  // even while the digital and verification streams continue advancing.
  while (recentFrames.size > 384) {
    const oldest = recentFrames.keys().next().value;
    if (typeof oldest === "number") recentFrames.delete(oldest);
  }
  scheduleFrameSyncCheck(frame.deviceId ?? "");
  return stored;
}

function pruneRetainedActionFrames(now = Date.now()) {
  for (const [sequence, stored] of retainedActionFrames) {
    if (Math.max(0, now - stored.frame.capturedAt) > ACTION_FRAME_MAX_AGE_MS) {
      retainedActionFrames.delete(sequence);
    }
  }
  while (retainedActionFrames.size > MAX_RETAINED_ACTION_FRAMES) {
    const oldest = retainedActionFrames.keys().next().value;
    if (typeof oldest !== "number") break;
    retainedActionFrames.delete(oldest);
  }
}

function retainActionFrame(stored: StoredFrame) {
  pruneRetainedActionFrames();
  retainedActionFrames.delete(stored.sequence);
  retainedActionFrames.set(stored.sequence, stored);
}

function storedFrameForSequence(sequence: number) {
  pruneRetainedActionFrames();
  return recentFrames.get(sequence) ?? retainedActionFrames.get(sequence);
}

function scheduleFrameSyncCheck(deviceId: string) {
  const runtime = deviceFrameRuntime(deviceId);
  const profile = calibrationProfileFor(deviceId);
  if (runtime.frameSyncCheckRunning || !profile) return;
  const now = Date.now();
  if (now - runtime.frameSyncLastCheckedAt < FRAME_SYNC_CHECK_INTERVAL_MS) return;
  const digital = runtime.latestControlFrame;
  const physical = runtime.latestVerificationFrame;
  if (
    !digital ||
    !physical ||
    digital.frame.source !== "iphone-wired-usb-video" ||
    digital.frame.deviceId !== physical.frame.deviceId
  ) {
    if (runtime.latestFrame?.frame.role === "verification") {
      runtime.frameSyncState = {
        status: "camera_fallback",
        score: null,
        checkedAt: now,
        detail: "Using the physical camera as the authoritative control view",
      };
    }
    return;
  }
  runtime.frameSyncCheckRunning = true;
  runtime.frameSyncLastCheckedAt = now;
  setImmediate(async () => {
    try {
      const result = await comparePhoneFramesBackground({
        digitalJpeg: digital.bytes,
        physicalJpeg: physical.bytes,
        physicalScreenPoints: profile.imagePoints,
      });
      const matched = result.score >= FRAME_SYNC_THRESHOLD;
      runtime.frameSyncMatchStreak = matched ? runtime.frameSyncMatchStreak + 1 : 0;
      const synchronized = matched && runtime.frameSyncMatchStreak >= 2;
      runtime.frameSyncState = {
        status: synchronized
          ? "synchronized"
          : matched
            ? "checking"
            : "mismatch",
        score: result.score,
        checkedAt: Date.now(),
        detail: synchronized
          ? "Wired screen and physical phone are synchronized"
          : matched
            ? "Confirming screen synchronization"
            : frameSyncEnforcedForDevice(deviceId)
              ? "Wired screen does not match the physical phone; touch is locked"
              : "Physical-camera correlation is low; wired control remains available",
      };
    } catch (error) {
      runtime.frameSyncMatchStreak = 0;
      runtime.frameSyncState = {
        status: "mismatch",
        score: null,
        checkedAt: Date.now(),
        detail: error instanceof Error
          ? `Unable to verify screen synchronization: ${error.message}`
          : "Unable to verify screen synchronization",
      };
    } finally {
      runtime.frameSyncCheckRunning = false;
    }
  });
}

function frameAgeMs(stored: StoredFrame | null) {
  if (!stored) return null;
  return Math.max(0, Date.now() - stored.frame.capturedAt);
}

function frameIsFresh(
  stored: StoredFrame | null,
  maxAgeMs = FRAME_FRESHNESS_MS,
) {
  const age = frameAgeMs(stored);
  return age !== null && age <= maxAgeMs;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requestIsLoopback(request: IncomingMessage) {
  const address = String(request.socket.remoteAddress ?? "");
  return address === "127.0.0.1" || address === "::1" ||
    address === "::ffff:127.0.0.1";
}

function requestIsLocalDashboard(request: IncomingMessage) {
  if (!requestIsLoopback(request)) return false;
  const origin = String(request.headers.origin ?? "").trim();
  return !origin || ALLOWED_ORIGINS.has(origin);
}

async function configuredOpenRouterKey() {
  const environmentKey = process.env.OPENROUTER_API_KEY?.trim();
  if (environmentKey) return { key: environmentKey, source: "environment" as const };
  try {
    const key = (await readFile(OPENROUTER_KEY_PATH, "utf8")).trim();
    return key ? { key, source: "local-file" as const } : null;
  } catch {
    return null;
  }
}

async function saveOpenRouterKey(key: string) {
  if (!/^sk-or-v1-[A-Za-z0-9_-]{32,200}$/.test(key)) {
    throw new PhonebaseApiError(
      "Enter a complete OpenRouter API key.",
      400,
      "INVALID_OPENROUTER_KEY",
    );
  }
  const verification = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!verification.ok) {
    throw new PhonebaseApiError(
      "OpenRouter rejected this key. Create a new key and try again.",
      400,
      "INVALID_OPENROUTER_KEY",
    );
  }
  await mkdir(dirname(OPENROUTER_KEY_PATH), { recursive: true, mode: 0o700 });
  await writeFile(OPENROUTER_KEY_PATH, `${key}\n`, { encoding: "utf8", mode: 0o600 });
}

function frameSyncEnforcedForDevice(deviceId: string) {
  const profile = calibrationProfileFor(deviceId);
  return FRAME_SYNC_ENFORCED || Boolean(
    profile?.placementCalibration?.method === "joint-camera-touch-v1",
  );
}


const CAMERA_FLEET_PATH = resolve(process.env.PHONEBASE_FLEET_CONFIG ?? "config/device-fleet.json");
const FLEET_DISCOVERY_PATH = resolve(process.env.PHONEBASE_FLEET_DISCOVERY_PATH ?? "build/runtime/fleet-discovery.json");
let lastCameraConfiguration: FleetCameraConfiguration | null = null;
let cameraFocusWrites = Promise.resolve();
function cameraConfiguration() {
  try {
    const configuration = JSON.parse(readFileSync(CAMERA_FLEET_PATH, "utf8")) as FleetCameraConfiguration;
    cameraPolicy(configuration);
    lastCameraConfiguration = configuration;
  } catch { /* A rejected reload keeps the last valid schedule. */ }
  return lastCameraConfiguration;
}
function connectedCameraIds() {
  return [...remoteNodes.values()].filter(node => node.socket.readyState === WebSocket.OPEN).map(node => node.deviceId);
}
function scheduledCameraIds(configuration: FleetCameraConfiguration) {
  const connected = new Set(connectedCameraIds());
  return selectCameraCaptures(configuration.devices.filter(device => connected.has(device.id)), cameraPolicy(configuration)).map(device => device.id);
}
function videoCaptureState(deviceId: string) {
  const configuration = cameraConfiguration();
  if (!configuration?.videoCapture?.maximumActiveCameras) return null;
  const policy = cameraPolicy(configuration);
  return { scheduled: scheduledCameraIds(configuration).includes(deviceId),
    minimumCapturedAt: policy.focusDeviceId === deviceId ? policy.focusedAt ?? 0 : 0 };
}
async function focusDeviceVideo(deviceId: string) {
  const run = async () => {
    let next: FleetCameraConfiguration;
    try {
      next = await updateFleetConfiguration(CAMERA_FLEET_PATH, configuration => {
        // Re-evaluate node state and transform the latest document under the
        // same cross-process lock used by hardware enrollment.
        const busyIds = [...remoteNodes.values()].filter(node => {
          const grbl = objectValue(objectValue(node.state).grbl);
          return grbl.activeOperation != null || /Run|Jog|Home/i.test(String(grbl.state ?? "")) ||
            agentBusyDevices.has(node.deviceId) || phoneHomeJobs.has(node.deviceId);
        }).map(node => node.deviceId);
        return configurationWithCameraFocus(configuration, deviceId, connectedCameraIds(), busyIds);
      });
    } catch (error) {
      if (error instanceof FleetConfigurationBusyError) throw new PhonebaseApiError("Hardware configuration is being updated. Try switching video again shortly.", 503, "FLEET_CONFIG_BUSY");
      throw new PhonebaseApiError(error instanceof Error ? error.message : "Cannot switch video.", 409, "VIDEO_BUSY");
    }
    lastCameraConfiguration = next;
    return { focusDeviceId: next.videoCapture?.focusDeviceId ?? null,
      scheduledDeviceIds: scheduledCameraIds(next), managed: Boolean(next.videoCapture?.maximumActiveCameras) };
  };
  const result = cameraFocusWrites.then(run, run);
  cameraFocusWrites = result.then(() => undefined, () => undefined);
  return result;
}

function tapReadiness(deviceId: string) {
  const capture = videoCaptureState(deviceId);
  if (capture?.scheduled === false) return { ready: false, reason: "Video is on standby. Open this device to start its live camera." };
  const runtime = existingDeviceFrameRuntime(deviceId);
  const profile = calibrationProfileFor(deviceId);
  const verificationCandidate = runtime?.latestVerificationFrame ?? null;
  const deviceFrame = frameIsFresh(verificationCandidate)
    ? verificationCandidate
    : runtime?.latestFrame ?? null;
  const frameReady = frameIsFresh(deviceFrame) && (!capture || (deviceFrame?.frame.capturedAt ?? 0) >= capture.minimumCapturedAt);
  if (!frameReady) {
    return {
      ready: false,
      reason: "A fresh camera frame is required.",
    };
  }
  const mainDeviceFrame = runtime?.latestFrame ?? null;
  if (mainDeviceFrame?.frame.source === "iphone-wired-usb-video") {
    const touchCalibrationPageActive =
      Date.now() - touchCalibrationHeartbeatAt <= TOUCH_CALIBRATION_HEARTBEAT_MS;
    const syncState = runtime?.frameSyncState;
    const syncAge = !syncState || syncState.checkedAt === null
      ? Number.POSITIVE_INFINITY
      : Date.now() - syncState.checkedAt;
    if (
      frameSyncEnforcedForDevice(deviceId) &&
      !touchCalibrationPageActive && (
        syncState?.status !== "synchronized" ||
        syncAge > FRAME_SYNC_FRESHNESS_MS
      )
    ) {
      return {
        ready: false,
        reason: syncState?.status === "mismatch"
          ? "The wired screen does not match the physical phone. Touch is locked to prevent a wrong tap."
          : "Verifying that the wired screen matches the physical phone before enabling touch.",
      };
    }
  }
  const profileReadiness = calibrationReadiness(profile, {
    deviceId,
    frame: deviceFrame
      ? {
          width: deviceFrame.frame.width,
          height: deviceFrame.frame.height,
        }
      : null,
  });
  if (!profileReadiness.ready) {
    return profileReadiness;
  }

  const node = remoteNodes.get(deviceId);
  if (!node || node.socket.readyState !== WebSocket.OPEN) {
    return {
      ready: false,
      reason: "The Phonebase hardware node is offline.",
    };
  }
  const nodeState = objectValue(node.state);
  const grbl = objectValue(nodeState.grbl);
  const tapProfile = objectValue(grbl.tapProfile);
  const activeOperation = objectValue(grbl.activeOperation);
  if (
    nodeState.appVersion !== "0.1.14" ||
    tapProfile.id !== profile?.id
  ) {
    return {
      ready: false,
      reason: "A hardware node with the matching verified touch profile is required.",
    };
  }
  if (grbl.connected !== true) {
    return {
      ready: false,
      reason: "The CH340/GRBL hardware link is offline.",
    };
  }
  if (grbl.homed !== true) {
    return {
      ready: false,
      reason: "The arm must complete machine homing after this controller connection.",
    };
  }
  if (Object.keys(activeOperation).length > 0) {
    return {
      ready: false,
      reason: "Wait for the current physical operation to finish before moving the stylus.",
    };
  }
  if (grbl.state !== "Idle") {
    return {
      ready: false,
      reason: `The arm must be idle before touch; current controller state is ${String(grbl.state ?? "unknown")}.`,
    };
  }
  if (grbl.calibrationActive !== true) {
    return {
      ready: false,
      reason: "Enable the local calibration window on the hardware node.",
    };
  }
  if (Math.abs(Number(grbl.z)) > 0.02) {
    return {
      ready: false,
      reason: "The stylus must be at the verified hover height before tap.",
    };
  }
  return { ready: true };
}

function phonebaseCapabilities(deviceId: string) {
  const readiness = tapReadiness(deviceId);
  const runtime = existingDeviceFrameRuntime(deviceId);
  const profile = calibrationProfileFor(deviceId);
  const nodeState = objectValue(remoteNodes.get(deviceId)?.state);
  const grbl = objectValue(nodeState.grbl);
  const tapProfile = objectValue(grbl.tapProfile);
  const activeOperation = objectValue(grbl.activeOperation);
  const homeReady = grbl.connected === true &&
    grbl.homed !== true &&
    Object.keys(activeOperation).length === 0;
  const homeReason = grbl.connected !== true
    ? "The CH340/GRBL hardware link must be online before homing."
    : grbl.homed === true
      ? "Machine homing is already complete for this controller connection."
      : Object.keys(activeOperation).length > 0
        ? "Wait for the current physical operation to finish before homing."
        : "The controller is not ready to home.";
  const controllerState = String(grbl.state ?? "unknown");
  const resumeReady = grbl.connected === true &&
    grbl.homed === true &&
    controllerState.startsWith("Hold") &&
    Object.keys(activeOperation).length === 0;
  const resumeReason = grbl.connected !== true
    ? "The CH340/GRBL hardware link must be online before resuming."
    : grbl.homed !== true
      ? "The arm must be homed before resuming motion."
      : Object.keys(activeOperation).length > 0
        ? "Wait for the current physical operation to finish before resuming."
        : controllerState === "Idle"
          ? "The controller is already idle."
          : `Resume is only available from Hold; current controller state is ${controllerState}.`;
  let phoneHomeReady = false;
  if (readiness.ready && profile?.navigation?.home) {
    try {
      const homeControl = profile.navigation.home;
      if (homeControl.strategy === "physical-button") {
        phoneHomeReady = true;
      } else if (tapProfile.supportsSwipe === true) {
        calibratedScreenPoint(profile, homeControl.startPoint);
        calibratedScreenPoint(profile, homeControl.endPoint);
        phoneHomeReady = true;
      }
    } catch {
      phoneHomeReady = false;
    }
  }
  const phoneKeys: ("back" | "home" | "enter")[] = readiness.ready && profile
    ? [
        ...(tapProfile.supportsSwipe === true ? ["back" as const] : []),
        "enter",
        ...(phoneHomeReady ? ["home" as const] : []),
      ]
    : [];
  const capabilities = buildPhonebaseCapabilities({
    frameReady: videoCaptureState(deviceId)?.scheduled !== false && frameIsFresh(
      runtime?.latestFrame ?? null,
    ),
    calibrationReady: readiness.ready,
    homeReady,
    homeReason,
    resumeReady,
    resumeReason,
    longPressReady:
      readiness.ready && tapProfile.supportsLongPress === true,
    swipeReady: readiness.ready && tapProfile.supportsSwipe === true,
    inputTextReady:
      readiness.ready && profile?.screen.width === 720 &&
      profile?.screen.height === 1_560,
    phoneKeys,
  });
  if (!readiness.ready) {
    capabilities.actions.hover_move = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.tap = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.long_press = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.swipe = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.input_text = {
      available: false,
      reason: readiness.reason,
    };
    capabilities.actions.phone_key = {
      available: false,
      reason: readiness.reason,
    };
  }
  return capabilities;
}

function publicNodeState(state: unknown) {
  return objectValue(state);
}

function publicNodes() {
  return [...remoteNodes.values()]
    .map((node) => ({
      deviceId: node.deviceId,
      connected: node.socket.readyState === WebSocket.OPEN,
      connectedAt: node.connectedAt,
      lastSeenAt: node.lastSeenAt,
      ageMs: Math.max(0, Date.now() - node.lastSeenAt),
      state: publicNodeState(node.state),
      lastEvent: node.lastEvent,
    }))
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
}

function publicPhonebaseDevice(node: RemoteNode) {
  const runtime = existingDeviceFrameRuntime(node.deviceId);
  const ownedFrame = runtime?.latestFrame ?? null;
  const nodeState = publicNodeState(node.state);
  return {
    id: node.deviceId,
    kind: "physical_robot",
    status: node.socket.readyState === WebSocket.OPEN ? "running" : "offline",
    connected: node.socket.readyState === WebSocket.OPEN,
    connectedAt: node.connectedAt,
    lastSeenAt: node.lastSeenAt,
    state: {
      ...nodeState,
      videoCapture: videoCaptureState(node.deviceId),
      screenSync: {
        ...(runtime?.frameSyncState ?? {
          status: "checking",
          score: null,
          checkedAt: null,
          detail: "Waiting for device video",
        }),
        enforced: frameSyncEnforcedForDevice(node.deviceId),
      },
      touchMapping: publicTouchMapping(node.deviceId),
      touchCalibration: {
        pageActive:
          Date.now() - touchCalibrationHeartbeatAt <= TOUCH_CALIBRATION_HEARTBEAT_MS,
        sampleCount: touchCalibrationSamples.length,
      },
    },
    screen: publicFrame(ownedFrame),
    capabilities: phonebaseCapabilities(node.deviceId),
  };
}

function publicTouchMapping(deviceId: string) {
  const profile = calibrationProfileFor(deviceId);
  if (!profile) return null;
  const screenCorners = [
    { x: 0, y: 0 },
    { x: profile.screen.width, y: 0 },
    { x: profile.screen.width, y: profile.screen.height },
    { x: 0, y: profile.screen.height },
  ] as const;
  const machinePoints = profile.controlMachinePoints ?? profile.machinePoints;
  const machineToScreen = homographyFromFourPoints(
    machinePoints,
    [...screenCorners],
  );
  const screenToMachine = homographyFromFourPoints(
    [...screenCorners],
    machinePoints,
  );
  const bounds = profile.safeMachineBounds;
  const isScreenPointReachable = (screenPoint: { x: number; y: number }) => {
    const point = projectPoint(screenToMachine, screenPoint);
    return point.x >= bounds.minimumX && point.x <= bounds.maximumX &&
      point.y >= bounds.minimumY && point.y <= bounds.maximumY;
  };
  const safeMachinePolygon = [
    { x: bounds.maximumX, y: bounds.maximumY },
    { x: bounds.minimumX, y: bounds.maximumY },
    { x: bounds.minimumX, y: bounds.minimumY },
    { x: bounds.maximumX, y: bounds.minimumY },
  ] as const;
  const reachableScreenPolygon = safeMachinePolygon.map((point) => {
    const mapped = projectPoint(machineToScreen, point);
    return {
      x: Math.round(mapped.x * 1000) / 1000,
      y: Math.round(mapped.y * 1000) / 1000,
    };
  });
  const fullScreenReachable = machinePoints.every((point) =>
    point.x >= bounds.minimumX && point.x <= bounds.maximumX &&
    point.y >= bounds.minimumY && point.y <= bounds.maximumY
  );
  // The first/last ~80 px are iOS system chrome rather than normal app
  // content. Report app coverage separately so a verified app-sized touch
  // surface is not presented as a large, dangerous-looking partial screen.
  const appScreenBounds = {
    left: 12,
    top: 82,
    right: profile.screen.width - 12,
    bottom: profile.screen.height - 92,
  };
  const appScreenCorners = [
    { x: appScreenBounds.left, y: appScreenBounds.top },
    { x: appScreenBounds.right, y: appScreenBounds.top },
    { x: appScreenBounds.right, y: appScreenBounds.bottom },
    { x: appScreenBounds.left, y: appScreenBounds.bottom },
  ] as const;
  const appAreaReachable = appScreenCorners.every((screenPoint) => {
    return isScreenPointReachable(screenPoint);
  });
  const systemChromeTargets = {
    bottomAddressBar: { x: profile.screen.width * 0.5, y: profile.screen.height * 0.865 },
    bottomToolbarLeft: { x: profile.screen.width * 0.18, y: profile.screen.height * 0.92 },
    bottomToolbarCenter: { x: profile.screen.width * 0.5, y: profile.screen.height * 0.92 },
    bottomToolbarRight: { x: profile.screen.width * 0.82, y: profile.screen.height * 0.92 },
    homeGestureStart: { x: profile.screen.width * 0.5, y: profile.screen.height * 0.96 },
  };
  const systemChromeReachability = Object.fromEntries(
    Object.entries(systemChromeTargets).map(([name, point]) => [
      name,
      isScreenPointReachable(point),
    ]),
  );
  return {
    calibrationId: profile.id,
    screen: profile.screen,
    coordinateSpace: "full_physical_screen",
    includesSystemChrome: true,
    safeMachineBounds: bounds,
    reachableScreenPolygon,
    fullScreenReachable,
    appAreaReachable,
    appScreenBounds,
    systemChromeReachability,
    frameSyncEnforced: frameSyncEnforcedForDevice(deviceId),
  };
}

function publicPhonebaseDeviceById(deviceId: string) {
  const node = remoteNodes.get(deviceId);
  if (node) return publicPhonebaseDevice(node);
  const ownedFrame = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
  if (!ownedFrame) return null;
  return {
    id: deviceId,
    kind: "physical_android",
    status: "offline",
    connected: false,
    connectedAt: null,
    lastSeenAt: null,
    state: null,
    screen: publicFrame(ownedFrame),
    capabilities: phonebaseCapabilities(deviceId),
  };
}

function phonebaseDeviceIds(): string[] {
  const ids = new Set(remoteNodes.keys());
  const configured = cameraConfiguration();
  const configuredIds = configured && new Set(configured.devices.map(device => device.id));
  for (const key of deviceFrameRuntimes.keys()) {
    if (key !== "unassigned-camera" && (!configuredIds || configuredIds.has(key))) ids.add(key);
  }
  return [...ids].sort();
}

function validateNodeCommand(value: Partial<NodeCommand>): NodeCommand {
  if (![
    "status",
    "hold",
    "home",
    "resume",
    "jog",
    "hover_move",
    "tap",
    "long_press",
    "swipe",
  ].includes(String(value.action))) {
    throw new Error(
      "The device node only accepts status, hold, home, resume, bounded jog, hover, and bounded touch actions.",
    );
  }

  const action = value.action as NodeCommand["action"];
  if (action === "hover_move") {
    const x = Number(value.params?.x);
    const y = Number(value.params?.y);
    const profileId = String(value.params?.profileId ?? "").trim();
    if (!Number.isFinite(x) || x < -300 || x > 300) {
      throw new Error("hover_move x is outside the hardware safety range.");
    }
    if (!Number.isFinite(y) || y < -300 || y > 300) {
      throw new Error("hover_move y is outside the hardware safety range.");
    }
    if (!profileId || profileId.length > 160) {
      throw new Error("hover_move profileId is invalid.");
    }
    return { action, params: { x, y, profileId } };
  }
  if (action === "tap" || action === "long_press") {
    const x = Number(value.params?.x);
    const y = Number(value.params?.y);
    const durationMs = Number(
      value.params?.durationMs ?? (
        action === "tap" ? PHONEBASE_TAP_DEFAULT_DURATION_MS : 800
      ),
    );
    const profileId = String(value.params?.profileId ?? "").trim();
    if (!Number.isFinite(x) || x < -20 || x > 38) {
      throw new Error("tap x must be between -20 and 38 mm.");
    }
    if (!Number.isFinite(y) || y < -90 || y > 30) {
      throw new Error("tap y must be between -90 and 30 mm.");
    }
    if (!profileId || profileId.length > 160) {
      throw new Error(`${action} profileId is invalid.`);
    }
    if (
      !Number.isInteger(durationMs) ||
      durationMs < (action === "tap" ? PHONEBASE_TAP_MIN_DURATION_MS : 500) ||
      durationMs > (action === "tap" ? PHONEBASE_TAP_MAX_DURATION_MS : 5_000)
    ) {
      throw new Error(`${action} durationMs is outside the hardware range.`);
    }
    return { action, params: { x, y, profileId, durationMs } };
  }
  if (action === "swipe") {
    const startX = Number(value.params?.startX);
    const startY = Number(value.params?.startY);
    const endX = Number(value.params?.endX);
    const endY = Number(value.params?.endY);
    const durationMs = Number(value.params?.durationMs ?? 500);
    const profileId = String(value.params?.profileId ?? "").trim();
    for (const [label, coordinate, minimum, maximum] of [
      ["startX", startX, -20, 38],
      ["endX", endX, -20, 38],
      ["startY", startY, -90, 30],
      ["endY", endY, -90, 30],
    ] as const) {
      if (
        !Number.isFinite(coordinate) ||
        coordinate < minimum ||
        coordinate > maximum
      ) {
        throw new Error(`swipe ${label} is outside the hardware safety range.`);
      }
    }
    if (!profileId || profileId.length > 160) {
      throw new Error("swipe profileId is invalid.");
    }
    if (!Number.isInteger(durationMs) || durationMs < 250 || durationMs > 3_000) {
      throw new Error("swipe durationMs must be between 250 and 3000 ms.");
    }
    return {
      action,
      params: { startX, startY, endX, endY, durationMs, profileId },
    };
  }
  if (action !== "jog") return { action };

  const axis = String(value.params?.axis ?? "").toUpperCase();
  const distance = Number(value.params?.distance);
  const feed = Number(value.params?.feed ?? 60);
  if (!["X", "Y", "Z"].includes(axis)) {
    throw new Error("jog axis must be X, Y, or Z.");
  }
  if (!Number.isFinite(distance) || distance === 0) {
    throw new Error("jog distance must be a non-zero number.");
  }
  if (!Number.isFinite(feed) || feed < 30 || feed > 600) {
    throw new Error("jog feed must be between 30 and 600 mm/min.");
  }

  return { action, params: { axis, distance, feed } };
}

function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "The request body is not valid JSON.";
  if (error instanceof Error) return error.message;
  return "Unknown error.";
}

type RentalAccessSettings = {
  gateway: URL;
  consoleUrl: URL;
  secret: string;
};

function rentalAccessSettings(): RentalAccessSettings {
  const gatewayValue = process.env.PHONEBASE_REMOTE_PUBLIC_URL?.trim() ?? "";
  const secret = process.env.PHONEBASE_LEASE_SIGNING_SECRET?.trim() ||
    process.env.PHONEBASE_REMOTE_TOKEN?.trim() || "";
  if (!gatewayValue) {
    throw new PhonebaseApiError(
      "Remote access is not configured on this station yet.",
      409,
      "REMOTE_ACCESS_NOT_CONFIGURED",
    );
  }
  if (secret.length < 32 || secret.length > 256) {
    throw new PhonebaseApiError(
      "The station rental signing secret is not configured.",
      409,
      "RENTAL_SECRET_NOT_CONFIGURED",
    );
  }
  const gateway = new URL(gatewayValue);
  const consoleUrl = new URL(CLOUD_CONSOLE_URL);
  const allowedOrigins = new Set(
    String(process.env.PHONEBASE_REMOTE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (
    gateway.protocol !== "https:" || gateway.username || gateway.password ||
    gateway.search || gateway.hash || consoleUrl.protocol !== "https:" ||
    !allowedOrigins.has(consoleUrl.origin)
  ) {
    throw new PhonebaseApiError(
      "The station HTTPS gateway or Cloud Beta origin is not configured correctly.",
      409,
      "REMOTE_ACCESS_INVALID",
    );
  }
  return { gateway, consoleUrl, secret };
}

function rentalStatus(lease: RentalLease) {
  if (lease.revokedAt) return "revoked" as const;
  return rentalLeaseActive(lease) ? "active" as const : "expired" as const;
}

function rentalLeaseView(
  lease: RentalLease,
  settings: RentalAccessSettings | null,
) {
  const status = rentalStatus(lease);
  if (status !== "active" || !settings) {
    return { ...lease, status, accessCode: null, accessLink: null };
  }
  const token = createRentalLeaseToken(lease, settings.secret);
  const legacyCode = createPhonebaseAccessCode(settings.gateway.origin, token);
  const accessCode = settings.gateway.origin === SHORT_CODE_GATEWAY
    ? createRentalShortCode(lease, settings.secret)
    : legacyCode;
  const accessLink = new URL(settings.consoleUrl);
  accessLink.hash = new URLSearchParams({ access: accessCode }).toString();
  return {
    ...lease,
    status,
    accessCode,
    accessLink: accessLink.toString(),
  };
}

async function rentalAdminSnapshot() {
  const registry = await readRentalLeaseRegistry(RENTAL_LEASES_PATH);
  let settings: RentalAccessSettings | null = null;
  let configurationError = "";
  try {
    settings = rentalAccessSettings();
  } catch (error) {
    configurationError = errorMessage(error);
  }
  return {
    configured: settings !== null,
    configurationError,
    consoleUrl: settings?.consoleUrl.toString() ?? CLOUD_CONSOLE_URL,
    leases: registry.leases
      .slice()
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map((lease) => rentalLeaseView(lease, settings)),
  };
}

let rentalWriteQueue = Promise.resolve();

function mutateRentalRegistry<T>(operation: () => Promise<T>): Promise<T> {
  const result = rentalWriteQueue.then(operation, operation);
  rentalWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

function publicActionReceipt(receipt: ActionReceipt) {
  return {
    ...receipt,
    completionScope: "physical_execution",
    uiVerification: objectValue(receipt.result).phoneUiVerified === true ? "verified" : "not_verified",
    elapsedMs: Math.max(
      0,
      (receipt.completedAt ?? receipt.updatedAt) - receipt.createdAt,
    ),
  };
}

function boundedHeader(value: string | string[] | undefined, fallback: string, max: number) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return String(candidate ?? "").trim().slice(0, max) || fallback;
}

function actionRequestContext(request: IncomingMessage): ActionRequestContext {
  return {
    source: clientSource(request.headers["x-phonebase-client"]),
    actor: boundedHeader(request.headers["x-phonebase-actor"], "local-api", 120),
    requestId: boundedHeader(request.headers["x-request-id"], randomUUID(), 160),
  };
}

function semanticCommandId() {
  return `action-${randomUUID()}`;
}

function auditReceipt(event: "created" | "updated" | "recovered", receipt: ActionReceipt) {
  let action: unknown = {};
  try { action = JSON.parse(receipt.actionFingerprint ?? "{}"); } catch {}
  observability.record({kind: `action.${receipt.status}`, level: receipt.status === "failed" ? "error" : "info",
    actor: receipt.actor, source: receipt.source ?? "api", deviceId: receipt.deviceId, requestId: receipt.requestId,
    receiptId: receipt.id, actionType: receipt.actionType, status: receipt.status,
    durationMs: (receipt.completedAt ?? receipt.updatedAt) - receipt.createdAt,
    details: {event, action: actionDetails(action), result: receipt.result, error: receipt.error, confirmation: actionConfirmation(receipt.result)}});
  if (receipt.status === "failed") observability.flag(`action-failure:${receipt.deviceId}`, true,
    "Device action failed — inspect receipt before retrying", receipt.deviceId, {receiptId:receipt.id, error:receipt.error}, "error");

  const entry = `${JSON.stringify({
    at: new Date().toISOString(),
    event,
    receiptId: receipt.id,
    deviceId: receipt.deviceId,
    idempotencyKey: receipt.idempotencyKey,
    actionType: receipt.actionType,
    status: receipt.status,
    actor: receipt.actor,
    requestId: receipt.requestId,
    error: receipt.error,
  })}\n`;
  auditWriteQueue = auditWriteQueue
    .then(async () => {
      await mkdir(dirname(AUDIT_LOG_PATH), { recursive: true });
      await appendFile(AUDIT_LOG_PATH, entry, "utf8");
    })
    .catch((error) => console.error(`Unable to append Phonebase audit log: ${errorMessage(error)}`));
}

function persistActionReceipts() {
  const snapshot = `${JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    receipts: [...actionReceipts.values()],
  }, null, 2)}\n`;
  receiptWriteQueue = receiptWriteQueue
    .then(async () => {
      await mkdir(dirname(ACTION_RECEIPTS_PATH), { recursive: true });
      const temporaryPath = `${ACTION_RECEIPTS_PATH}.${process.pid}.tmp`;
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, ACTION_RECEIPTS_PATH);
    })
    .catch((error) => console.error(`Unable to persist Phonebase receipts: ${errorMessage(error)}`));
}

async function restoreActionReceipts() {
  try {
    const snapshot = JSON.parse(await readFile(ACTION_RECEIPTS_PATH, "utf8")) as {
      receipts?: ActionReceipt[];
    };
    for (const stored of snapshot.receipts ?? []) {
      if (!stored?.id || !stored.deviceId || !stored.idempotencyKey) continue;
      const receipt: ActionReceipt = {
        ...stored,
        actor: stored.actor || "unknown",
        requestId: stored.requestId || "unknown",
      };
      if (receipt.status === "accepted" || receipt.status === "executing") {
        receipt.status = "failed";
        receipt.updatedAt = Date.now();
        receipt.completedAt = receipt.updatedAt;
        receipt.error = "The control plane restarted before final hardware confirmation; verify the device before retrying.";
        auditReceipt("recovered", receipt);
      }
      actionReceipts.set(receipt.id, receipt);
      actionReceiptIdsByKey.set(
        actionReceiptKey(receipt.deviceId, receipt.idempotencyKey),
        receipt.id,
      );
    }
    pruneActionReceipts();
    persistActionReceipts();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Unable to restore Phonebase receipts: ${errorMessage(error)}`);
    }
  }
}

function actionReceiptKey(deviceId: string, idempotencyKey: string) {
  return `${deviceId}\u0000${idempotencyKey}`;
}

function existingActionReceipt(deviceId: string, idempotencyKey: string) {
  const id = actionReceiptIdsByKey.get(
    actionReceiptKey(deviceId, idempotencyKey),
  );
  return id ? actionReceipts.get(id) ?? null : null;
}

function deleteActionReceipt(receipt: ActionReceipt) {
  actionReceipts.delete(receipt.id);
  actionReceiptIdsByKey.delete(
    actionReceiptKey(receipt.deviceId, receipt.idempotencyKey),
  );
}

function pruneActionReceipts() {
  const ids = receiptIdsToPrune(
    [...actionReceipts.values()],
    MAX_ACTION_RECEIPTS_PER_DEVICE,
    MAX_ACTION_RECEIPTS,
  );
  for (const id of ids) {
    const receipt = actionReceipts.get(id);
    if (receipt) deleteActionReceipt(receipt);
  }
}

function createActionReceipt(input: {
  id: string;
  deviceId: string;
  idempotencyKey: string;
  actionType: PhonebaseSemanticAction["type"];
  actionFingerprint?: string;
  source?: string;
  result?: unknown;
  actor: string;
  requestId: string;
}) {
  const existing = existingActionReceipt(input.deviceId, input.idempotencyKey);
  if (existing) return existing;
  const now = Date.now();
  const receipt: ActionReceipt = {
    id: input.id,
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey,
    actionType: input.actionType,
    actionFingerprint: input.actionFingerprint,
    source: input.source ?? "api",
    status: "accepted",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
    result: input.result ?? null,
    actor: input.actor,
    requestId: input.requestId,
  };
  actionReceipts.set(receipt.id, receipt);
  actionReceiptIdsByKey.set(
    actionReceiptKey(receipt.deviceId, receipt.idempotencyKey),
    receipt.id,
  );
  pruneActionReceipts();
  persistActionReceipts();
  auditReceipt("created", receipt);
  return receipt;
}

function updateActionReceipt(
  id: string,
  status: ActionReceipt["status"],
  input: { error?: string | null; result?: unknown } = {},
) {
  const receipt = actionReceipts.get(id);
  if (!receipt) return null;
  if (receipt.status === "completed" || receipt.status === "failed") {
    return receipt;
  }
  const now = Date.now();
  receipt.status = status;
  receipt.updatedAt = now;
  receipt.completedAt = status === "completed" || status === "failed"
    ? now
    : null;
  if ("error" in input) receipt.error = input.error ?? null;
  if ("result" in input) {
    const planned = objectValue(receipt.result);
    const operation = receipt.actionType === "hover_move"
      ? compactHoverReceiptOperation(input.result)
      : input.result;
    receipt.result = Object.keys(planned).length > 0 && "calibrationId" in planned
      ? { ...planned, operation }
      : operation;
  }
  persistActionReceipts();
  auditReceipt("updated", receipt);
  return receipt;
}

await restoreActionReceipts();
await recorder.load();

function grblStateFrom(value: unknown) {
  const state = objectValue(value);
  const nested = objectValue(state.grbl);
  return Object.keys(nested).length > 0 ? nested : state;
}

function reconcileOperationState(deviceId: string, stateValue: unknown) {
  const grbl = grblStateFrom(stateValue);
  const active = objectValue(grbl.activeOperation);
  const last = objectValue(grbl.lastOperation);
  const activeDecision = operationReceiptDecision(active);
  const lastDecision = operationReceiptDecision(last);
  if (activeDecision) {
    const receipt = actionReceipts.get(activeDecision.id);
    if (receipt?.deviceId === deviceId) {
      updateActionReceipt(activeDecision.id, activeDecision.status, {
        error: activeDecision.error,
        result: activeDecision.result,
      });
    }
  }
  if (lastDecision) {
    const receipt = actionReceipts.get(lastDecision.id);
    if (receipt?.deviceId !== deviceId) return;
    updateActionReceipt(lastDecision.id, lastDecision.status, {
      error: lastDecision.error,
      result: lastDecision.result,
    });
  }
}

function reconcileCommandResult(deviceId: string, payloadValue: unknown) {
  const payload = objectValue(payloadValue);
  const calibrationJog = calibrationJogs.get(deviceId);
  if (calibrationJog && calibrationJog.id === payload.id && payload.ok === false) {
    calibrationJogs.set(deviceId, {
      ...calibrationJog, status: "failed", error: String(payload.error ?? "The controller rejected the move."),
    });
  }
  const decision = commandResultReceiptDecision(payload);
  if (!decision) return;
  const receipt = actionReceipts.get(decision.id);
  if (!receipt || receipt.deviceId !== deviceId) return;
  reconcileOperationState(deviceId, payload.state);
  updateActionReceipt(decision.id, decision.status, {
    error: decision.error,
    result: decision.result,
  });
}

function failOpenReceipts(deviceId: string, reason: string) {
  for (const receipt of actionReceipts.values()) {
    if (
      receipt.deviceId === deviceId &&
      (receipt.status === "accepted" || receipt.status === "executing")
    ) {
      updateActionReceipt(receipt.id, "failed", { error: reason });
    }
  }
}

function sendNodeEnvelope(node: RemoteNode, input: {
  id: string;
  action: NodeCommand["action"];
  params?: NodeCommand["params"];
}) {
  const envelope = {
    type: "command",
    id: input.id.slice(0, 160),
    deviceId: node.deviceId,
    expiresAt: Date.now() + 5_000,
    ttlMs: 5_000,
    action: input.action,
    ...(input.params ? { params: input.params } : {}),
  };
  node.socket.send(JSON.stringify(envelope));
  return envelope;
}

function requireOnlineNode(deviceId: string): RemoteNode {
  const node = remoteNodes.get(deviceId);
  if (!node || node.socket.readyState !== WebSocket.OPEN) {
    throw new PhonebaseApiError(
      `Phonebase node is offline: ${deviceId}`,
      503,
      "DEVICE_OFFLINE",
    );
  }
  if (Date.now() - node.lastSeenAt > 6_000) {
    throw new PhonebaseApiError(
      `Phonebase node heartbeat is stale: ${deviceId}`,
      503,
      "DEVICE_HEARTBEAT_STALE",
    );
  }
  return node;
}

function unavailableAction(
  deviceId: string,
  action: PhonebaseSemanticAction,
): never {
  const availability = phonebaseCapabilities(deviceId).actions[action.type];
  throw new PhonebaseApiError(
    availability.reason ?? `Action ${action.type} is not available.`,
    409,
    action.type === "hover_move" || action.type === "tap" || action.type === "long_press" || action.type === "swipe" || action.type === "input_text" || action.type === "phone_key"
      ? "CALIBRATION_REQUIRED"
      : "ACTION_UNAVAILABLE",
  );
}

async function executeSemanticAction(
  deviceId: string,
  input: ReturnType<typeof parsePhonebaseActionEnvelope>,
  context: ActionRequestContext,
) {
  const { action, idempotencyKey } = input;
  if (recorderBusyDevices.has(deviceId) && context.actor !== "local-recorder") {
    if (action.type !== "hold") {
      throw new PhonebaseApiError(
        "A recorded workflow is running on this device.",
        409,
        "DEVICE_BUSY",
      );
    }
  }
  if (agentBusyDevices.has(deviceId) && context.actor !== "local-agent") {
    if (action.type !== "hold") {
      throw new PhonebaseApiError(
        "A natural-language Agent task is running on this device.",
        409,
        "DEVICE_BUSY",
      );
    }
  }
  if (publishing.busy(deviceId) && context.actor !== "publishing-worker") {
    if (action.type !== "hold") throw new PhonebaseApiError("手机正在执行发送计划，请先暂停。", 409, "DEVICE_BUSY");
    publishing.stopDevice(deviceId);
  }
  context = {
    ...context,
    actionFingerprint: context.actionFingerprint ?? JSON.stringify(action),
  };
  const profile = calibrationProfileFor(deviceId);

  const priorReceipt = existingActionReceipt(deviceId, idempotencyKey);
  if (priorReceipt) {
    if (context.actor.startsWith("rental:") && priorReceipt.actor !== context.actor) {
      throw new PhonebaseApiError("This action identity is unavailable. Use a new workflow step ID.", 409, "ACTION_IDENTITY_CONFLICT");
    }
    if (priorReceipt.actionType !== action.type ||
        (priorReceipt.actionFingerprint && priorReceipt.actionFingerprint !== context.actionFingerprint)) {
      throw new PhonebaseApiError("This idempotency key was already used for a different action. Use a new workflow step ID.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return {
      status: priorReceipt.status,
      action,
      commandId: priorReceipt.id,
      receipt: publicActionReceipt(priorReceipt),
      replayed: true,
    };
  }

  const node = requireOnlineNode(deviceId);

  const homeJob = phoneHomeJobs.get(deviceId);
  if (homeJob && action.type !== "status" && action.type !== "hold" && context.homeWorkflowId !== homeJob.id) {
    throw new PhonebaseApiError("Phone Home is being verified. Wait for its final receipt.", 409, "DEVICE_BUSY");
  }

  if (action.type === "status" || action.type === "wait") {
    const receipt = createActionReceipt({
      id: semanticCommandId(), deviceId, idempotencyKey,
      actionType: action.type, ...context,
    });
    updateActionReceipt(receipt.id, "executing");
    if (action.type === "wait") {
      await new Promise((resolve) => setTimeout(resolve, action.durationMs));
    }
    const result = action.type === "wait"
      ? { waitedMs: action.durationMs }
      : { device: publicPhonebaseDevice(node) };
    updateActionReceipt(receipt.id, "completed", { result });
    return { status: "completed", action, ...result, receipt: publicActionReceipt(receipt) };
  }
  if (action.type === "hold") {
    if (homeJob) homeJob.cancelled = true;
    const command = sendNodeEnvelope(node, {
      id: semanticCommandId(),
      action: "hold",
    });
    const receipt = createActionReceipt({
      id: command.id,
      deviceId,
      idempotencyKey,
      actionType: action.type,
      ...context,
    });
    return {
      status: "accepted",
      action,
      commandId: command.id,
      receipt: publicActionReceipt(receipt),
    };
  }

  if (action.type === "resume") {
    const availability = phonebaseCapabilities(deviceId).actions.resume;
    if (!availability.available) unavailableAction(deviceId, action);
    const command = sendNodeEnvelope(node, {
      id: semanticCommandId(),
      action: "resume",
    });
    const receipt = createActionReceipt({
      id: command.id,
      deviceId,
      idempotencyKey,
      actionType: action.type,
      ...context,
    });
    return {
      status: "accepted",
      action,
      commandId: command.id,
      receipt: publicActionReceipt(receipt),
    };
  }

  if (action.type === "home") {
    const availability = phonebaseCapabilities(deviceId).actions.home;
    if (!availability.available) unavailableAction(deviceId, action);
    const command = sendNodeEnvelope(node, {
      id: semanticCommandId(),
      action: "home",
    });
    const receipt = createActionReceipt({
      id: command.id,
      deviceId,
      idempotencyKey,
      actionType: action.type,
      ...context,
    });
    return {
      status: "accepted",
      action,
      commandId: command.id,
      receipt: publicActionReceipt(receipt),
    };
  }

  const availability = phonebaseCapabilities(deviceId).actions[action.type];
  if (!availability.available) unavailableAction(deviceId, action);
  if (
    action.type === "phone_key" &&
    !availability.supportedKeys?.includes(action.key)
  ) {
    throw new PhonebaseApiError(
      `Phone key ${action.key} is not available for this device. Read capabilities.actions.phone_key.supportedKeys before choosing a key.`,
      409,
      "PHONE_KEY_UNAVAILABLE",
    );
  }

  if (action.type === "input_text" && profile) {
    const stored = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
    if (!stored || !frameIsFresh(stored)) {
      throw new PhonebaseApiError(
        "A fresh phone frame is required before physical text entry.",
        409,
        "FRAME_UNAVAILABLE",
      );
    }
    const geometry = frameGeometry(stored);
    if (!geometry || geometry.width !== 720 || geometry.height !== 1_560) {
      throw new PhonebaseApiError(
        "The installed keyboard map requires a calibrated 720×1560 iPhone screen.",
        409,
        "KEYBOARD_PROFILE_MISMATCH",
      );
    }
    const canonical = await renderModelScreenFrame(stored.bytes, geometry, 4_096);
    const keyboardOcr = await recognizeVisionText(
      `data:image/jpeg;base64,${canonical.bytes.toString("base64")}`,
    );
    const phoneKeypadVisible = looksLikeIosPhoneKeypad(keyboardOcr);
    if (
      !phoneKeypadVisible &&
      !iosEnglishKeyboardVisible(canonical.bytes) &&
      !looksLikeIosKeyboard(keyboardOcr)
    ) {
      throw new PhonebaseApiError(
        "The calibrated iOS English keyboard is not visibly focused; no key was pressed.",
        409,
        "KEYBOARD_NOT_VISIBLE",
      );
    }
    const initialShift = phoneKeypadVisible ? undefined : iosKeyboardInitialShift(keyboardOcr);
    const observedKeyboard = phoneKeypadVisible ? undefined : iosKeyboardGeometryFromOcr(keyboardOcr);
    if (!phoneKeypadVisible && !profile.keyboard && !observedKeyboard) {
      throw new PhonebaseApiError("Could not resolve all three visible alphabet rows and layout switch; no typing was sent.",409,"KEYBOARD_GEOMETRY_UNCLEAR");
    }
    if (!phoneKeypadVisible && /[a-z]/i.test(action.text) && initialShift === undefined) {
      throw new PhonebaseApiError(
        "The keyboard letter case is unclear; obtain a clear alphabet-keyboard view before typing. No key was pressed.",
        409,
        "KEYBOARD_CASE_UNCLEAR",
      );
    }
    const keyboardPoints = phoneKeypadVisible
      ? iosPhoneKeypadSequence(action.text)
      : iosEnglishKeyboardSequence(
          action.text,
          profile.keyboard
            ? { points: profile.keyboard.points, strict: profile.keyboard.strict }
            : undefined,
          initialShift,
          observedKeyboard,
        );
    const machinePoints = keyboardPoints.map((point) => ({
      ...calibratedScreenPoint(profile, point),
      ...(point.delayAfterMs === undefined ? {} : { delayAfterMs: point.delayAfterMs }),
    }));
    const command = sendNodeEnvelope(node, {
      id: semanticCommandId(),
      action: "input_text",
      params: {
        points: machinePoints,
        durationMs: 55,
        ...(action.touchZ === undefined ? {} : { touchZ: action.touchZ }),
        profileId: profile.id,
      },
    });
    const receipt = createActionReceipt({
      id: command.id,
      deviceId,
      idempotencyKey,
      actionType: action.type,
      ...context,
      result: {
        characterCount: action.text.length,
        physicalTapCount: machinePoints.length,
        calibrationId: profile.id,
      },
    });
    return {
      status: "accepted",
      action,
      characterCount: action.text.length,
      physicalTapCount: machinePoints.length,
      calibrationId: profile.id,
      commandId: command.id,
      receipt: publicActionReceipt(receipt),
    };
  }

  if (action.type === "phone_key" && profile) {
    if (action.key === "back") {
      const stored=existingDeviceFrameRuntime(deviceId)?.latestFrame;
      const geometry = stored && frameIsFresh(stored) ? frameGeometry(stored) : null;
      const canonical = stored && geometry ? await renderModelScreenFrame(stored.bytes, geometry, 1560) : null;
      const point = canonical ? visibleInsetBackPoint(canonical.bytes) : null;
      if (!stored || !point) throw new PhonebaseApiError("No verified top-left Back chevron is visible; no blind edge swipe was sent. Observe and choose an explicit visible control.",409,"PHONE_KEY_UNAVAILABLE");
      const delegated: {status:string;receipt?:ReturnType<typeof publicActionReceipt>;[key:string]:unknown} = await executeSemanticAction(deviceId,{
        idempotencyKey,
        action:{type:"tap",point,viewport:{width:720,height:1560},frameSequence:stored.sequence,durationMs:40,touchZ:action.touchZ??profile.tap.touchZ},
      },{...context,receiptActionType:"phone_key"});
      return {...delegated,action,physicalGesture:"tap",navigationStrategy:"visible-inset-chevron"};
    }
    const homeControl = profile.navigation?.home;
    if (action.key === "home" && !homeControl) {
      throw new PhonebaseApiError(
        "This installation has no verified phone Home control; no gesture was sent.",
        409,
        "PHONE_HOME_NOT_CALIBRATED",
      );
    }
    if (action.key === "home" && homeControl?.strategy === "screen-swipe") {
      return startVerifiedPhoneHome(deviceId, input, context, profile);
    }
    const gesture = buildPhoneKeyCommand(profile, action.key, action.touchZ);
    const command = sendNodeEnvelope(node, {
      id: semanticCommandId(),
      action: gesture.action,
      params: gesture.params,
    });
    const receipt = createActionReceipt({
      id: command.id,
      deviceId,
      idempotencyKey,
      actionType: action.type,
      ...context,
      result: {
        key: action.key,
        physicalGesture: gesture.action,
        touchZ: gesture.params.touchZ,
        phoneUiVerified: false,
        ...(gesture.target ? { target: gesture.target } : {}),
        calibrationId: profile.id,
      },
    });
    return {
      status: "accepted",
      action,
      physicalGesture: gesture.action,
      ...(gesture.target ? { target: gesture.target } : {}),
      calibrationId: profile.id,
      commandId: command.id,
      receipt: publicActionReceipt(receipt),
    };
  }

  if (
    action.type === "hover_move" ||
    action.type === "tap" ||
    action.type === "long_press" ||
    action.type === "swipe"
  ) {
    const plannedStoredFrame = storedFrameForSequence(action.frameSequence);
    const plannedFrame = plannedStoredFrame?.frame;
    const plannedFrameAgeMs = plannedFrame
      ? Math.max(0, Date.now() - plannedFrame.capturedAt)
      : Number.POSITIVE_INFINITY;
    if (
      !plannedFrame ||
      plannedFrame.deviceId !== deviceId ||
      plannedFrameAgeMs > ACTION_FRAME_MAX_AGE_MS
    ) {
      throw new PhonebaseApiError(
        "The requested touch action was planned from a stale camera frame.",
        409,
        "STALE_FRAME",
      );
    }
    const plannedGeometry = plannedStoredFrame
      ? frameGeometry(plannedStoredFrame)
      : null;
    const matchesScreenViewport = Boolean(
      plannedGeometry &&
      action.viewport.width === plannedGeometry.width &&
      action.viewport.height === plannedGeometry.height,
    );
    const matchesRawViewport = Boolean(
      plannedFrame &&
      action.viewport.width === plannedFrame.width &&
      action.viewport.height === plannedFrame.height,
    );
    if (!plannedStoredFrame || (!matchesScreenViewport && !matchesRawViewport)) {
      throw new PhonebaseApiError(
        "The touch viewport does not match the referenced camera frame.",
        409,
        "FRAME_VIEWPORT_MISMATCH",
      );
    }
    let frameValidation: Record<string, unknown> = {
      mode: "fresh",
      plannedFrameAgeMs: Math.round(plannedFrameAgeMs),
    };
    if (plannedFrameAgeMs > ACTION_FRAME_FRESHNESS_MS) {
      const currentStoredFrame = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
      const currentFrame = currentStoredFrame?.frame;
      if (
        !currentStoredFrame ||
        !currentFrame ||
        !frameIsFresh(currentStoredFrame) ||
        currentFrame.deviceId !== deviceId ||
        currentFrame.source !== plannedFrame.source ||
        currentFrame.width !== plannedFrame.width ||
        currentFrame.height !== plannedFrame.height ||
        currentStoredFrame.mimeType !== plannedStoredFrame.mimeType
      ) {
        throw new PhonebaseApiError(
          "The observed frame is older than 15 seconds and no comparable current frame is available. Obtain a new screenshot.",
          409,
          "FRAME_REVALIDATION_REQUIRED",
        );
      }
      const targetPoints = matchesRawViewport
        ? action.type === "swipe"
          ? [
              normalizePhonebasePoint(action.start, action.viewport),
              normalizePhonebasePoint(action.end, action.viewport),
            ]
          : [normalizePhonebasePoint(action.point, action.viewport)]
        : undefined;
      let comparison;
      try {
        comparison = await compareFrameContent({
          observed: plannedStoredFrame.bytes,
          current: currentStoredFrame.bytes,
          targetPoints,
        });
      } catch {
        throw new PhonebaseApiError(
          "The observed frame could not be compared with the current screen. Obtain a new screenshot.",
          409,
          "FRAME_REVALIDATION_REQUIRED",
        );
      }
      if (!comparison.matched) {
        throw new PhonebaseApiError(
          "The phone screen or target region changed after the screenshot. Obtain a new screenshot before clicking.",
          409,
          "FRAME_CHANGED",
        );
      }
      frameValidation = {
        mode: "content-match",
        plannedFrameAgeMs: Math.round(plannedFrameAgeMs),
        currentFrameSequence: currentStoredFrame.sequence,
        ...comparison,
      };
    }
    // Camera pixels and mirror pixels must converge on the same calibrated
    // screen transform, including any independently measured control correction.
    const calibratedPoint = (point: { x: number; y: number }) =>
      calibratedScreenPoint(profile!, framePointToScreenPoint(
        plannedFrame, profile!, point, action.viewport,
      ));
    const normalized = action.type === "swipe"
      ? {
          start: normalizePhonebasePoint(action.start, action.viewport),
          end: normalizePhonebasePoint(action.end, action.viewport),
        }
      : {
          point: normalizePhonebasePoint(action.point, action.viewport),
        };
    if (
      (action.type === "hover_move" || action.type === "tap" || action.type === "long_press") &&
      profile
    ) {
      const machinePoint = calibratedPoint(action.point);
      const selectedTouchZ = action.type === "hover_move"
        ? undefined
        : action.touchZ ?? profile.tap.touchZ;
      const command = sendNodeEnvelope(node, {
        id: semanticCommandId(),
        action: action.type,
        params: {
          x: machinePoint.x,
          y: machinePoint.y,
          ...(action.type === "hover_move" ? {} : { durationMs: action.durationMs }),
          ...(selectedTouchZ === undefined ? {} : { touchZ: selectedTouchZ }),
          profileId: profile.id,
        },
      });
      const receipt = createActionReceipt({
        id: command.id,
        deviceId,
        idempotencyKey,
        actionType: context.receiptActionType ?? action.type,
        ...context,
        result: {
          machinePoint,
          calibrationId: profile.id,
          frameValidation,
          ...(selectedTouchZ === undefined ? {} : { touchZ: selectedTouchZ }),
        },
      });
      return {
        status: "accepted",
        action,
        normalized,
        machinePoint,
        calibrationId: profile.id,
        frameValidation,
        commandId: command.id,
        receipt: publicActionReceipt(receipt),
      };
    }
    if (action.type === "swipe" && profile) {
      const machineStart = calibratedPoint(action.start);
      const machineEnd = calibratedPoint(action.end);
      const selectedTouchZ = action.touchZ ?? profile.tap.touchZ;
      const command = sendNodeEnvelope(node, {
        id: semanticCommandId(),
        action: "swipe",
        params: {
          startX: machineStart.x,
          startY: machineStart.y,
          endX: machineEnd.x,
          endY: machineEnd.y,
          durationMs: action.durationMs,
          touchZ: selectedTouchZ,
          profileId: profile.id,
        },
      });
      const receipt = createActionReceipt({
        id: command.id,
        deviceId,
        idempotencyKey,
        actionType: action.type,
        ...context,
        result: {
          machineStart,
          machineEnd,
          calibrationId: profile.id,
          touchZ: selectedTouchZ,
          frameValidation,
        },
      });
      return {
        status: "accepted",
        action,
        normalized,
        machineStart,
        machineEnd,
        calibrationId: profile.id,
        frameValidation,
        commandId: command.id,
        receipt: publicActionReceipt(receipt),
      };
    }
    return {
      status: "accepted",
      action,
      normalized,
      frameValidation,
    };
  }

  return unavailableAction(deviceId, action);
}

function startVerifiedPhoneHome(
  deviceId: string,
  input: ReturnType<typeof parsePhonebaseActionEnvelope>,
  context: ActionRequestContext,
  profile: PhonebaseCalibrationProfile,
) {
  const home = profile.navigation?.home;
  if (input.action.type !== "phone_key" || home?.strategy !== "screen-swipe") {
    throw new Error("Verified phone Home is not configured.");
  }
  const recovery = home.bottomEdgeRecovery;
  const touchZ = home.gestureTouchZ ?? input.action.touchZ ?? recovery?.touchZ ?? profile.tap.touchZ;
  const parent = createActionReceipt({ id: semanticCommandId(), deviceId, idempotencyKey: input.idempotencyKey,
    actionType: "phone_key", ...context, result: { key: "home", workflow: "verified-phone-home-v1", touchZ, phoneUiVerified: false } });
  const job = { id: parent.id, cancelled: false };
  phoneHomeJobs.set(deviceId, job);
  const childReceipts: string[] = [];
  const observations: Array<{ scene: string; frameSequence: number; frameAgeMs: number; durationMs: number; ocrMs: number }> = [];
  const checkpoint = async () => {
    if (job.cancelled || phoneHomeJobs.get(deviceId) !== job || parent.status === "failed") throw new Error("Phone Home stopped; no further motion was sent.");
    requireOnlineNode(deviceId);
    const competing = [...actionReceipts.values()].some(receipt => receipt.deviceId === deviceId &&
      receipt.id !== parent.id && !childReceipts.includes(receipt.id) &&
      (receipt.status === "accepted" || receipt.status === "executing"));
    if (competing) throw new Error("Another device action is still pending; Phone Home stopped before further motion.");
    if (calibrationProfileFor(deviceId) !== profile) throw new Error("Calibration changed during Phone Home.");
    if (context.actor.startsWith("rental:")) {
      const registry = await readRentalLeaseRegistry(RENTAL_LEASES_PATH);
      const lease = registry.leases.find(lease => lease.id === context.actor.slice(7));
      if (!lease || !rentalLeaseActive(lease) || !(lease.deviceIds ?? [lease.deviceId]).includes(deviceId)) {
        throw new Error("Customer access ended during Phone Home; no further motion was sent.");
      }
    }
  };
  let weatherDismissed = false;
  const observe = async (afterCompletedAt = Date.now() - 1_000) => {
    const startedAt = performance.now();
    // Our own Home animation can momentarily make the independently captured
    // camera/mirror frames disagree. Wait for the existing two-match gate,
    // then select a NEW frame. Never bypass it or replay the completed swipe.
    await waitForPhoneHomeReadiness({ checkpoint, now: Date.now,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      readiness: () => {
        const readiness = tapReadiness(deviceId);
        const runtime = existingDeviceFrameRuntime(deviceId);
        const sync = runtime?.frameSyncState;
        const waitingForScreenSync = runtime?.latestFrame?.frame.source === "iphone-wired-usb-video" &&
          frameSyncEnforcedForDevice(deviceId) && (sync?.status !== "synchronized" ||
            sync.checkedAt === null || sync.checkedAt < afterCompletedAt ||
            Date.now() - sync.checkedAt > FRAME_SYNC_FRESHNESS_MS);
        return { ...readiness, ready: readiness.ready && !waitingForScreenSync,
          waitingForScreenSync: Boolean(waitingForScreenSync) };
      },
    });
    // iOS can still be animating after the hardware has completed and parked.
    // Observe a settled fresh frame before deciding whether recovery is needed.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await checkpoint();
      const stored = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
      if (stored && frameIsFresh(stored) && stored.frame.capturedAt >= afterCompletedAt + 900) {
        const geometry = frameGeometry(stored);
        if (!geometry) throw new Error("Phone Home requires calibrated video geometry.");
        const canonical = await renderModelScreenFrame(stored.bytes, geometry, 1_560);
        const ocr = await recognizeVisionText(`data:image/jpeg;base64,${canonical.bytes.toString("base64")}`, undefined, "accurate");
        await checkpoint();
        if (Date.now() - stored.frame.capturedAt > 2_500) throw new Error("Phone Home observation became stale; no recovery tap was sent.");
        retainActionFrame(stored);
        const weatherCancel = deviceId === "sf-black-arm-13" ? weatherSettingsCancel(ocr) : null;
        const homeVisible = homeScreenGridVisible(ocr);
        const libraryVisible = !homeVisible && appLibraryVisible(ocr);
        const switcherPoint = !homeVisible && !libraryVisible
          ? await appSwitcherDismissPoint(canonical.bytes, ocr, { allowBottom: Boolean(recovery) }) : null;
        const observation = { scene: weatherCancel ? "weather-settings-invitation" : homeVisible ? "home" : libraryVisible ? "app-library" : switcherPoint ? "app-switcher" : "unrecognized",
          frameSequence: stored.sequence, frameAgeMs: Date.now() - stored.frame.capturedAt,
          durationMs: Math.round(performance.now() - startedAt), ocrMs: ocr.elapsedMs };
        observations.push(observation);
        observability.record({ kind: "home.observation", actor: context.actor, source: context.source, deviceId,
          requestId: context.requestId, receiptId: parent.id, durationMs: observation.durationMs,
          details: { ...observation, index: observations.length } });
        return { weatherCancel, homeVisible, appLibraryVisible: libraryVisible, appSwitcherVisible: !!switcherPoint, switcherPoint, stored, geometry };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("No fresh post-action frame arrived to verify Phone Home.");
  };
  const execute = async (action: PhonebaseSemanticAction, stage: string) => {
    await checkpoint();
    const result = await executeSemanticAction(deviceId, { idempotencyKey: `${parent.id}-${stage}`, action }, {
      ...context, actionFingerprint: JSON.stringify(action), homeWorkflowId: parent.id,
    });
    const receiptId = result.receipt?.id;
    if (!receiptId) throw new Error("Phone Home stage did not return a hardware receipt.");
    childReceipts.push(receiptId);
    const receipt = await waitForActionReceipt(receiptId, `Phone Home ${stage}`);
    return receipt.completedAt!;
  };
  updateActionReceipt(parent.id, "executing");
  void runPhoneHomeWorkflow({ checkpoint, observe: async after => {
    const first = await observe(after);
    if (!first.weatherCancel || weatherDismissed) return first;
    const current = await observe(first.stored.frame.capturedAt);
    if (!current.weatherCancel) return current;
    weatherDismissed = true;
    const done = await execute({ type: "tap", point: current.weatherCancel,
      viewport: { width: current.geometry.width, height: current.geometry.height },
      frameSequence: current.stored.sequence, durationMs: PHONEBASE_TAP_DEFAULT_DURATION_MS, touchZ },
      "close-weather-settings-invitation");
    const closed = await observe(done);
    if (closed.weatherCancel) throw new Error("Weather settings invitation did not close.");
    return closed;
  },
    exitAppSwitcher: async observation => {
      // Require a second settled observation and matching content. In
      // particular, never tap a dock app if Home appeared in the meantime.
      const current = await observe(observation.stored.frame.capturedAt);
      if (current.homeVisible) return current.stored.frame.capturedAt;
      if (!current.switcherPoint || !observation.switcherPoint) {
        throw new Error("App switcher changed before recovery; no background tap was sent.");
      }
      const comparison = await compareFrameContent({ observed: observation.stored.bytes, current: current.stored.bytes,
        targetPoints: [{ x: current.switcherPoint.x / current.geometry.width, y: current.switcherPoint.y / current.geometry.height }] });
      if (!comparison.matched) throw new Error("App switcher is not stable; no background tap was sent.");
      return execute({ type: "tap", point: current.switcherPoint, durationMs: PHONEBASE_TAP_DEFAULT_DURATION_MS,
        touchZ, viewport: { width: current.geometry.width, height: current.geometry.height },
        frameSequence: current.stored.sequence }, "exit-app-switcher");
    },
    swipe: observation => execute({ type: "swipe", start: home.startPoint, end: home.endPoint,
      durationMs: home.durationMs, touchZ, viewport: { width: observation.geometry.width, height: observation.geometry.height },
      frameSequence: observation.stored.sequence }, "swipe"),
    dismissAtVerifiedBottomEdge: recovery ? observation => execute({ type: "tap", point: recovery.point, durationMs: PHONEBASE_TAP_DEFAULT_DURATION_MS,
      touchZ, viewport: { width: observation.geometry.width, height: observation.geometry.height },
      frameSequence: observation.stored.sequence }, "bottom-edge") : undefined,
    // App Library is already a SpringBoard page: another upward Home swipe does
    // not leave it. One observed right swipe returns to the adjacent Home page.
    exitAppLibrary: observation => execute({ type: "swipe",
      start: { x: observation.geometry.width * 0.2, y: observation.geometry.height * 0.5 },
      end: { x: observation.geometry.width * 0.8, y: observation.geometry.height * 0.5 },
      durationMs: 300, touchZ, viewport: { width: observation.geometry.width, height: observation.geometry.height },
      frameSequence: observation.stored.sequence }, "exit-app-library"),
  }).then(result => {
    updateActionReceipt(parent.id, result.phoneUiVerified ? "completed" : "failed", {
      error: result.phoneUiVerified ? null : "The Home gesture finished, but the Home screen was not visually confirmed. No further actions were sent.",
      result: { key: "home", workflow: "verified-phone-home-v1", calibrationId: profile.id, touchZ, ...result, childReceipts, observations },
    });
  }).catch(error => {
    updateActionReceipt(parent.id, "failed", { error: errorMessage(error), result: { key: "home", phoneUiVerified: false, childReceipts, observations } });
  }).finally(() => {
    if (phoneHomeJobs.get(deviceId) === job) phoneHomeJobs.delete(deviceId);
  });
  return { status: "accepted", action: input.action, commandId: parent.id, receipt: publicActionReceipt(parent) };
}

async function executeVisualAction(
  deviceId: string,
  input: PhonebaseVisualActionEnvelope,
  context: ActionRequestContext,
) {
  const actionFingerprint = JSON.stringify(input.action);
  const priorReceipt = existingActionReceipt(deviceId, input.idempotencyKey);
  if (priorReceipt) {
    if (context.actor.startsWith("rental:") && priorReceipt.actor !== context.actor) {
      throw new PhonebaseApiError(
        "This action identity is unavailable. Use a new workflow step ID.",
        409,
        "ACTION_IDENTITY_CONFLICT",
      );
    }
    if (priorReceipt.actionFingerprint !== actionFingerprint) {
      throw new PhonebaseApiError(
        "This idempotency key was already used for a different action. Use a new workflow step ID.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    return {
      status: priorReceipt.status,
      action: input.action,
      commandId: priorReceipt.id,
      receipt: publicActionReceipt(priorReceipt),
      replayed: true,
      visual: {
        type: input.action.type,
        requested: input.action.type === "open_app"
          ? input.action.appName
          : input.action.target,
        replayed: true,
      },
    };
  }
  const startedAt = performance.now();
  let stored = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
  if (!stored || stored.frame.deviceId !== deviceId || !frameIsFresh(stored)) {
    throw new PhonebaseApiError(
      "A fresh phone frame is required for visual control.",
      503,
      "FRAME_UNAVAILABLE",
    );
  }
  let dataUrl = `data:${stored.mimeType};base64,${stored.bytes.toString("base64")}`;
  let size = { width: stored.frame.width, height: stored.frame.height };
  let ocr = await recognizeVisionText(dataUrl, undefined, "fast");
  let textMatches = input.action.type === "tap_text"
    ? locateVisibleTextMatches(input.action.target, ocr, size)
    : [];
  let match = input.action.type === "open_app"
    ? locateHomeApp(input.action.appName, ocr, size)
    : textMatches.length === 1 ? textMatches[0] : null;
  if (!match) {
    ocr = await recognizeVisionText(dataUrl, undefined, "accurate");
    textMatches = input.action.type === "tap_text"
      ? locateVisibleTextMatches(input.action.target, ocr, size)
      : [];
    match = input.action.type === "open_app"
      ? locateHomeApp(input.action.appName, ocr, size)
      : textMatches.length === 1 ? textMatches[0] : null;
  }
  let navigatedHome = false;
  if (
    !match &&
    input.action.type === "open_app" &&
    !homeScreenGridVisible(ocr)
  ) {
    const priorFrameSequence = stored.sequence;
    const preparationKey = `visual-home-${createHash("sha256")
      .update(input.idempotencyKey)
      .digest("hex")
      .slice(0, 32)}`;
    const home = parsePhonebaseActionEnvelope({
      idempotencyKey: preparationKey,
      action: { type: "phone_key", key: "home" },
    });
    const homeResult = await executeSemanticAction(deviceId, home, {
      ...context,
      actionFingerprint: undefined,
    });
    const homeReceiptId = homeResult.receipt?.id;
    if (homeReceiptId) await waitForActionReceipt(homeReceiptId, "Visual Home preparation");

    const frameDeadline = Date.now() + 5_000;
    while (Date.now() < frameDeadline) {
      const candidate = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
      if (candidate && candidate.sequence > priorFrameSequence && frameIsFresh(candidate)) {
        stored = candidate;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    stored = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? stored;
    if (!stored || !frameIsFresh(stored)) {
      throw new PhonebaseApiError(
        "Phone Home completed, but no fresh Home Screen frame arrived.",
        503,
        "FRAME_UNAVAILABLE",
      );
    }
    dataUrl = `data:${stored.mimeType};base64,${stored.bytes.toString("base64")}`;
    size = { width: stored.frame.width, height: stored.frame.height };
    ocr = await recognizeVisionText(dataUrl, undefined, "fast");
    match = locateHomeApp(input.action.appName, ocr, size);
    if (!match) {
      ocr = await recognizeVisionText(dataUrl, undefined, "accurate");
      match = locateHomeApp(input.action.appName, ocr, size);
    }
    navigatedHome = true;
  }
  if (!match) {
    // Dock icons have no labels. Only ask the visual locator on an observed
    // Home grid; never guess a fixed dock position or infer app installation.
    if (input.action.type === "open_app" && homeScreenGridVisible(ocr)) {
      const configured = await configuredOpenRouterKey();
      if (configured) {
        const located = await locateAgentTargetWithJev(configured.key,`${input.action.appName} app icon`,dataUrl,stored.sequence);
        const qualified = qualifyJevActionCandidate(located);
        if (qualified.safeToAct) match = {
          point:{x:qualified.point.x*size.width,y:qualified.point.y*size.height},
          recognizedLabel:`${input.action.appName} (visually located icon)`,confidence:located.confidence,
        };
      }
    }
  }
  if (!match) {
    const requested = input.action.type === "open_app"
      ? input.action.appName
      : input.action.target;
    const ambiguous = input.action.type === "tap_text" && textMatches.length > 1;
    throw new PhonebaseApiError(
      ambiguous
        ? `Visible target is ambiguous (${textMatches.length} matches): ${requested}.`
        : `Visible target was not found: ${requested}. OCR saw: ${ocrTextSample(ocr) || "no readable text"}.`,
      409,
      ambiguous ? "VISUAL_TARGET_AMBIGUOUS" : "VISUAL_TARGET_NOT_FOUND",
    );
  }
  const tap = parsePhonebaseActionEnvelope({
    idempotencyKey: input.idempotencyKey,
    action: {
      type: "tap",
      point: match.point,
      viewport: size,
      frameSequence: stored.sequence,
    },
  });
  const result = await executeSemanticAction(deviceId, tap, {
    ...context,
    actionFingerprint,
  });
  return {
    ...result,
    visual: {
      type: input.action.type,
      requested: input.action.type === "open_app"
        ? input.action.appName
        : input.action.target,
      recognizedLabel: match.recognizedLabel,
      confidence: match.confidence,
      point: match.point,
      frameSequence: stored.sequence,
      planningMs: Math.round(performance.now() - startedAt),
      navigatedHome,
    },
  };
}

function replayActionForFrame(
  recorded: RecordedAction,
  stored: StoredFrame | null,
): PhonebaseSemanticAction {
  if (
    recorded.type === "tap" ||
    recorded.type === "long_press" ||
    recorded.type === "swipe"
  ) {
    if (!stored || !frameIsFresh(stored)) {
      throw new PhonebaseApiError(
        "A fresh phone frame is required to replay this step.",
        503,
        "FRAME_UNAVAILABLE",
      );
    }
    const geometry = frameGeometry(stored);
    if (!geometry) {
      throw new PhonebaseApiError(
        "The current phone frame has no replay geometry.",
        409,
        "FRAME_GEOMETRY_UNAVAILABLE",
      );
    }
    const viewport = { width: geometry.width, height: geometry.height };
    const point = (value: { x: number; y: number }) => ({
      x: value.x * viewport.width,
      y: value.y * viewport.height,
    });
    if (recorded.type === "swipe") {
      return {
        ...recorded,
        start: point(recorded.start),
        end: point(recorded.end),
        viewport,
        frameSequence: stored.sequence,
      };
    }
    return {
      ...recorded,
      point: point(recorded.point),
      viewport,
      frameSequence: stored.sequence,
    };
  }
  return { ...recorded };
}

async function waitForActionReceipt(receiptId: string, label = "Action") {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const receipt = actionReceipts.get(receiptId);
    if (!receipt) throw new Error(`${label} receipt disappeared: ${receiptId}`);
    if (receipt.status === "completed") return receipt;
    if (receipt.status === "failed") {
      throw new Error(receipt.error || `${label} ${receipt.actionType} failed.`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${label} did not finish: ${receiptId}`);
}

function publicAgentTask(task: AgentTask) {
  return {
    id: task.id,
    deviceId: task.deviceId,
    goal: task.goal,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    model: task.model,
    maxSteps: task.maxSteps,
    budgetUsd: task.budgetUsd,
    costUsd: task.costUsd,
    inputTokens: task.inputTokens,
    outputTokens: task.outputTokens,
    steps: task.steps,
    summary: task.summary,
    error: task.error,
  };
}

async function waitForNewAgentFrame(deviceId: string, afterSequence: number) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const stored = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
    if (stored && stored.sequence > afterSequence && frameIsFresh(stored)) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      return existingDeviceFrameRuntime(deviceId)?.latestFrame ?? stored;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  }
  return existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
}

function summarizeAgentAction(action: PhoneAgentAction) {
  if (action.type === "input_text") return `input_text (${action.text.length} characters)`;
  if (action.type === "open_app") return `open_app ${action.appName}`;
  if (action.type === "tap_text") return `tap_text ${action.target}`;
  if (action.type === "tap") return `tap ${action.target}`;
  if (action.type === "long_press") return `long_press ${action.target} (${action.durationMs}ms)`;
  if (action.type === "swipe") return `swipe ${action.target}`;
  if (action.type === "phone_key") return `phone_key ${action.key}`;
  if (action.type === "wait") return `wait ${action.durationMs}ms`;
  return "none";
}

function goalAuthorizesExternalSend(goal: string) {
  return /(?:发(?:送|消息)|告诉|传给|send|message|text|post|publish)/iu.test(goal);
}

function actionLooksLikeExternalSend(action: PhoneAgentAction) {
  if (action.type !== "tap" && action.type !== "tap_text") return false;
  return /(?:发送|send|post|publish)/iu.test(action.target);
}

function jevTargetForAgentAction(action: PhoneAgentAction) {
  if (action.type === "open_app") return `${action.appName} app icon`;
  if (action.type === "tap_text" || action.type === "tap" || action.type === "long_press") return action.target;
  return null;
}

function plannerPointForAgentAction(action: PhoneAgentAction) {
  if (action.type === "open_app" || action.type === "tap_text" || action.type === "tap" || action.type === "long_press") {
    return { x: action.x, y: action.y };
  }
  return undefined;
}

async function locateAgentTargetWithJev(
  apiKey: string,
  target: string,
  imageDataUrl: string,
  frameSequence: number,
) {
  const startedAt = performance.now();
  const upstream = await fetch(OPENROUTER_DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://127.0.0.1:3020",
      "X-OpenRouter-Title": "PhoneUse Jev Action Locator",
    },
    body: JSON.stringify(buildJevLocateRequest(target, imageDataUrl)),
    signal: AbortSignal.timeout(30_000),
  });
  if (!upstream.ok) {
    const payload = objectValue(await upstream.json().catch(() => ({})));
    const errorRecord = objectValue(payload.error);
    throw new Error(String(errorRecord.message ?? payload.message ?? `Jev returned ${upstream.status}.`).slice(0, 300));
  }
  const located = parseJevLocateResponse(await upstream.json());
  return {
    ...located,
    target,
    frameSequence,
    latencyMs: Math.round(performance.now() - startedAt),
    cost: located.usage.cost,
  };
}

async function executePhoneAgentAction(
  task: AgentTask,
  action: PhoneAgentAction,
  stored: StoredFrame,
  stepIndex: number,
  apiKey: string,
  imageDataUrl: string,
) {
  if (actionLooksLikeExternalSend(action) && !goalAuthorizesExternalSend(task.goal)) {
    throw new Error("The goal does not explicitly authorize an external send or publish action.");
  }
  const idempotencyKey = `agent-${task.id}-${stepIndex}`;
  const context: ActionRequestContext = {
    actor: "local-agent",
    source: "dashboard",
    requestId: idempotencyKey,
  };
  let locator: AgentTaskStep["locator"];
  let recoverableError = "";
  let semantic: PhonebaseSemanticAction;
  const jevTarget = jevTargetForAgentAction(action);
  if (jevTarget) {
    const geometry = frameGeometry(stored);
    if (!geometry) throw new Error("The current phone frame has no Agent coordinate geometry.");
    const located = await traceTrialStage(event => observability.record(event), { ...context, deviceId: task.deviceId }, "locator",
      () => locateAgentTargetWithJev(apiKey, jevTarget, imageDataUrl, stored.sequence));
    const qualification = qualifyJevActionCandidate({
      visibleProbability: located.visibleProbability,
      confidence: located.confidence,
      box: located.box,
      plannerPoint: plannerPointForAgentAction(action),
    });
    task.costUsd += located.usage.cost;
    task.inputTokens += located.usage.inputTokens;
    task.outputTokens += located.usage.outputTokens;
    locator = {
      model: located.model,
      provider: located.provider,
      target: located.target,
      frameSequence: located.frameSequence,
      visibleProbability: located.visibleProbability,
      confidence: located.confidence,
      box: located.box,
      plannerAgreement: qualification.plannerAgreement,
      qualifiedBy: qualification.qualifiedBy,
      boxArea: qualification.boxArea,
      latencyMs: located.latencyMs,
      cost: located.cost,
    };
    if (task.costUsd > task.budgetUsd) {
      throw new PhonebaseApiError(
        `The Agent reached its $${task.budgetUsd.toFixed(2)} task budget before the Jev-qualified action.`,
        409,
        "AGENT_BUDGET_EXCEEDED",
      );
    }
    if (!qualification.safeToAct) {
      recoverableError = `Jev did not qualify ${JSON.stringify(jevTarget)} for a click ` +
        `(visible ${Math.round(located.visibleProbability * 100)}%, confidence ${Math.round(located.confidence * 100)}%, ` +
        `planner agreement ${qualification.plannerAgreement ? "yes" : "no"}).`;
      return { locator, recoverableError };
    }
    retainActionFrame(stored);
    const point = {
      x: qualification.point.x * geometry.width,
      y: qualification.point.y * geometry.height,
    };
    const viewport = { width: geometry.width, height: geometry.height };
    semantic = action.type === "long_press"
      ? {
          type: "long_press",
          point,
          viewport,
          frameSequence: stored.sequence,
          durationMs: action.durationMs,
        }
      : {
          type: "tap",
          point,
          viewport,
          frameSequence: stored.sequence,
          durationMs: PHONEBASE_TAP_DEFAULT_DURATION_MS,
        };
  } else if (action.type === "swipe") {
      const geometry = frameGeometry(stored);
      if (!geometry) throw new Error("The current phone frame has no Agent coordinate geometry.");
      retainActionFrame(stored);
      semantic = {
        type: "swipe",
        start: { x: action.startX * geometry.width, y: action.startY * geometry.height },
        end: { x: action.endX * geometry.width, y: action.endY * geometry.height },
        viewport: { width: geometry.width, height: geometry.height },
        frameSequence: stored.sequence,
        durationMs: action.durationMs,
      };
  } else if (action.type === "input_text") {
    semantic = { type: "input_text", text: action.text };
  } else if (action.type === "phone_key") {
    semantic = { type: "phone_key", key: action.key };
  } else if (action.type === "wait") {
    semantic = { type: "wait", durationMs: action.durationMs };
  } else {
    throw new Error("A terminal Agent decision cannot execute a physical action.");
  }
  await traceTrialStage(event => observability.record(event), { ...context, deviceId: task.deviceId }, "execution", async () => {
    const result = await executeSemanticAction(task.deviceId, parsePhonebaseActionEnvelope({
      idempotencyKey,
      action: semantic,
    }), context);
    if (result.receipt?.id) await waitForActionReceipt(result.receipt.id, "Agent action");
  });
  return { locator, recoverableError };
}

async function runPhoneAgentTask(task: AgentTask) {
  if (agentBusyDevices.has(task.deviceId) || recorderBusyDevices.has(task.deviceId) || publishing.busy(task.deviceId)) {
    task.status = "failed";
    task.error = "This device is already executing another workflow.";
    task.updatedAt = Date.now();
    return;
  }
  agentBusyDevices.add(task.deviceId);
  observability.record({ kind: "agent.run", actor: "local-agent", source: "dashboard", deviceId: task.deviceId,
    requestId: task.id, status: "running", details: { model: task.model, maxSteps: task.maxSteps } });
  try {
    const configured = await configuredOpenRouterKey();
    if (!configured) throw new Error("OpenRouter is not configured.");
    for (let index = 0; index < task.maxSteps; index += 1) {
      if (task.stopRequested) {
        task.status = "stopped";
        task.summary = "Stopped by the local operator.";
        task.updatedAt = Date.now();
        return;
      }
      const stored = existingDeviceFrameRuntime(task.deviceId)?.latestFrame ?? null;
      if (!stored || !frameIsFresh(stored)) throw new Error("A fresh phone frame is required for the Agent.");
      const geometry = frameGeometry(stored);
      if (!geometry) throw new Error("The current phone frame cannot be rectified for the Agent.");
      const canonical = await renderModelScreenFrame(stored.bytes, geometry, 1_568);
      const imageDataUrl = `data:image/jpeg;base64,${canonical.bytes.toString("base64")}`;
      const startedAt = performance.now();
      const traceContext = { deviceId: task.deviceId, actor: "local-agent", source: "dashboard", requestId: `agent-${task.id}-${index + 1}` };
      const decision = await traceTrialStage(event => observability.record(event), traceContext, "planner", async () => {
      const upstream = await fetch(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${configured.key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://127.0.0.1:3020",
          "X-OpenRouter-Title": "PhoneUse Natural Language Agent",
        },
        body: JSON.stringify(buildPhoneAgentRequest({
          model: task.model,
          goal: task.goal,
          imageDataUrl,
          step: index + 1,
          history: task.steps.map((step) => ({
            action: summarizeAgentAction(step.action),
            outcome: step.outcome,
            summary: step.summary,
          })),
        })),
        signal: AbortSignal.timeout(90_000),
      });
      if (!upstream.ok) {
        const payload = objectValue(await upstream.json().catch(() => ({})));
        const errorRecord = objectValue(payload.error);
        throw new Error(String(errorRecord.message ?? payload.message ?? `OpenRouter returned ${upstream.status}.`).slice(0, 300));
      }
      return parsePhoneAgentResponse(await upstream.json());
      });
      task.costUsd += decision.usage.cost;
      task.inputTokens += decision.usage.inputTokens;
      task.outputTokens += decision.usage.outputTokens;
      task.summary = decision.summary;
      task.updatedAt = Date.now();
      if (task.costUsd > task.budgetUsd) {
        task.status = "blocked";
        task.error = `The Agent reached its $${task.budgetUsd.toFixed(2)} task budget before the next action.`;
        return;
      }
      if (decision.status !== "continue") {
        let terminalStatus: "done" | "blocked" = decision.status;
        let terminalError = decision.status === "blocked" ? decision.summary : "";
        if (
          decision.status === "done" &&
          task.steps.some((step) => actionLooksLikeExternalSend(step.action))
        ) {
          const failure = visibleMessageDeliveryFailure(
            await recognizeVisionText(imageDataUrl, undefined, "accurate"),
          );
          if (failure) {
            terminalStatus = "blocked";
            terminalError = `The message action ran, but the phone visibly reports ${failure}. Delivery was not successful.`;
          }
        }
        task.steps.push({
          index: index + 1,
          at: Date.now(),
          summary: decision.summary,
          action: decision.action,
          outcome: terminalStatus,
          latencyMs: Math.round(performance.now() - startedAt),
          cost: decision.usage.cost,
        });
        task.status = terminalStatus === "done" ? "succeeded" : "blocked";
        task.error = terminalError;
        task.updatedAt = Date.now();
        return;
      }
      const actionStarted = performance.now();
      let outcome = `${summarizeAgentAction(decision.action)} completed`;
      let locator: AgentTaskStep["locator"];
      try {
        const execution = await executePhoneAgentAction(
          task,
          decision.action,
          stored,
          index + 1,
          configured.key,
          imageDataUrl,
        );
        locator = execution.locator;
        if (execution.recoverableError) outcome = execution.recoverableError;
      } catch (error) {
        const feedback = recoverableAgentExecutionFeedback(
          error,
          summarizeAgentAction(decision.action),
        );
        if (!feedback) throw error;
        outcome = feedback;
      }
      task.steps.push({
        index: index + 1,
        at: Date.now(),
        summary: decision.summary,
        action: decision.action,
        outcome,
        latencyMs: Math.round(performance.now() - startedAt),
        cost: decision.usage.cost + (locator?.cost ?? 0),
        ...(locator ? { locator } : {}),
      });
      task.updatedAt = Date.now();
      await traceTrialStage(event => observability.record(event), traceContext, "frame_wait",
        () => waitForNewAgentFrame(task.deviceId, stored.sequence));
      const actionElapsed = performance.now() - actionStarted;
      if (actionElapsed < 200) await new Promise((resolvePromise) => setTimeout(resolvePromise, 200 - actionElapsed));
    }
    task.status = "blocked";
    task.error = `The Agent reached the ${task.maxSteps}-step limit without visible completion.`;
    task.updatedAt = Date.now();
  } catch (error) {
    task.status = error instanceof PhonebaseApiError && error.code === "AGENT_BUDGET_EXCEEDED"
      ? "blocked"
      : "failed";
    task.error = error instanceof Error ? error.message : "The Agent task failed.";
    task.updatedAt = Date.now();
  } finally {
    observability.record({ kind: "agent.run", actor: "local-agent", source: "dashboard", deviceId: task.deviceId,
      requestId: task.id, status: task.status, level: task.status === "failed" || task.status === "blocked" ? "warning" : "info",
      durationMs: Date.now() - task.createdAt, details: { model: task.model, steps: task.steps.length,
        costUsd: task.costUsd, inputTokens: task.inputTokens, outputTokens: task.outputTokens } });
    agentBusyDevices.delete(task.deviceId);
  }
}

async function replayRecordedWorkflow(workflow: RecorderWorkflow) {
  if (recorderBusyDevices.has(workflow.deviceId) || publishing.busy(workflow.deviceId)) {
    throw new PhonebaseApiError(
      "This device is already executing a workflow.",
      409,
      "DEVICE_BUSY",
    );
  }
  recorderBusyDevices.add(workflow.deviceId);
  const run = await recorder.beginRun(workflow);
  try {
    for (let index = 0; index < workflow.steps.length; index += 1) {
      const step = workflow.steps[index];
      await recorder.updateRun(run.id, {
        stepIndex: index,
        stepLabel: step.label,
      });
      const stored = existingDeviceFrameRuntime(workflow.deviceId)?.latestFrame ?? null;
      const action = replayActionForFrame(step.action, stored);
      const envelope = parsePhonebaseActionEnvelope({
        idempotencyKey: `recorder-${run.id}-${step.id}`,
        action,
      });
      const result = await executeSemanticAction(workflow.deviceId, envelope, {
        actor: "local-recorder",
        source: "dashboard",
        requestId: `recorder-${run.id}-${index}`,
      });
      if (result.receipt?.id) await waitForActionReceipt(result.receipt.id, "Recorded action");
      if (index + 1 < workflow.steps.length) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 180));
      }
    }
    return await recorder.updateRun(run.id, {
      status: "succeeded",
      stepIndex: workflow.steps.length - 1,
      stepLabel: "Completed",
      endedAt: Date.now(),
    });
  } catch (error) {
    await recorder.updateRun(run.id, {
      status: "failed",
      endedAt: Date.now(),
      error: errorMessage(error),
    });
    throw error;
  } finally {
    recorderBusyDevices.delete(workflow.deviceId);
  }
}

function finiteCalibrationNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new PhonebaseApiError(`${label} must be a finite number.`, 400, "INVALID_CALIBRATION");
  }
  return number;
}

async function persistCalibrationDraftChange(change: (drafts: Map<string, CalibrationDraft>) => void) {
  const result = calibrationDraftWriteQueue.then(async () => {
    const next = new Map(calibrationDrafts);
    change(next);
    try { await calibrationDraftStore.save(next); }
    catch {
      throw new PhonebaseApiError("Calibration work could not be saved. Existing saved drafts were preserved; check station storage before continuing.", 503, "CALIBRATION_DRAFT_STORAGE_UNAVAILABLE");
    }
    calibrationDrafts.clear();
    for (const [id, draft] of next) calibrationDrafts.set(id, draft);
  });
  calibrationDraftWriteQueue = result.catch(() => undefined);
  await result;
}

function matchingCalibrationDraft(drafts: Map<string, CalibrationDraft>, expected: CalibrationDraft) {
  const current = drafts.get(expected.deviceId);
  if (!current || current.startedAt !== expected.startedAt || current.frame.sequence !== expected.frame.sequence) {
    throw new PhonebaseApiError("The calibration session changed. Reload its draft before recording another point.", 409, "CALIBRATION_DRAFT_CHANGED");
  }
  return current;
}

function calibrationState(deviceId: string) {
  const draft = calibrationDrafts.get(deviceId) ?? null;
  return {
    active: calibrationProfileFor(deviceId),
    draft,
    jog: calibrationJogs.get(deviceId) ?? null,
    outputPath: calibrationOutputPath(deviceId),
    cornerOrder: ["top_left", "top_right", "bottom_right", "bottom_left"],
  };
}

function requireCalibrationNode(deviceId: string) {
  const node = requireOnlineNode(deviceId);
  const grbl = objectValue(objectValue(node.state).grbl);
  assertCalibrationStatus(grbl, node.lastStateAt);
  return { node, grbl };
}

function requireCalibrationCamera(deviceId: string, draftFrame?: { width: number; height: number }) {
  const runtime = existingDeviceFrameRuntime(deviceId);
  const stored = runtime?.latestVerificationFrame ?? runtime?.latestFrame ?? null;
  const frame = stored?.frame.source === "iphone-wired-usb-video" ? null : stored?.frame ?? null;
  assertCalibrationFrame(frame, draftFrame);
  return stored!;
}

function assertNoPendingCalibrationJog(deviceId: string) {
  const jog = calibrationJogs.get(deviceId);
  if (!jog || (jog.status !== "executing" && jog.status !== "unconfirmed")) return;
  // An uncertain move must never be resent automatically. A later final status
  // for the same operation can release the local lock after a response timeout.
  if (jog.status === "unconfirmed") {
    const node = remoteNodes.get(deviceId);
    const grbl = objectValue(objectValue(node?.state).grbl);
    const last = objectValue(grbl.lastOperation);
    const positionMatches = jog.target && Math.abs(Number(grbl.x) - jog.target.x) <= 0.15 &&
      Math.abs(Number(grbl.y) - jog.target.y) <= 0.15;
    if (node && Date.now() - node.lastStateAt <= 6_000 && last.id === jog.id &&
        (last.status === "failed" || (last.status === "completed" && positionMatches))) {
      calibrationJogs.set(deviceId, {
        id: jog.id, status: last.status,
        ...(last.status === "failed" ? { error: String(last.error ?? "The move failed.") } : {}),
      });
      return;
    }
  }
  throw new PhonebaseApiError(
    `Calibration move ${jog.id} is ${jog.status}. Wait for its final controller status and inspect the position before another calibration command.`,
    409, "CALIBRATION_JOG_PENDING",
  );
}

async function updateCalibration(
  deviceId: string,
  inputValue: unknown,
) {
  const input = objectValue(inputValue);
  const operation = String(input.operation ?? "").trim();
  assertNoPendingCalibrationJog(deviceId);
  const runtime = existingDeviceFrameRuntime(deviceId);
  const deviceFrame = runtime?.latestVerificationFrame ?? runtime?.latestFrame ?? null;

  if (operation === "begin") {
    const deviceFrame = requireCalibrationCamera(deviceId);
    const requestedWidth = Math.round(Number(input.screenWidth ?? 720));
    const requestedHeight = Math.round(Number(
      input.screenHeight ?? Math.max(480, Math.round(requestedWidth * 16 / 9)),
    ));
    if (
      requestedWidth < 320 || requestedWidth > 2160 ||
      requestedHeight < 480 || requestedHeight > 4096
    ) {
      throw new PhonebaseApiError(
        "The rectified screen size is invalid.",
        400,
        "INVALID_CALIBRATION",
      );
    }
    const draft: CalibrationDraft = {
      deviceId,
      frame: {
        width: deviceFrame.frame.width,
        height: deviceFrame.frame.height,
        sequence: deviceFrame.sequence,
      },
      screen: { width: requestedWidth, height: requestedHeight },
      imagePoints: [null, null, null, null],
      machinePoints: [null, null, null, null],
      startedAt: new Date().toISOString(),
    };
    await persistCalibrationDraftChange(drafts => drafts.set(deviceId, draft));
    return calibrationState(deviceId);
  }

  if (operation === "jog") {
    const { node, grbl } = requireCalibrationNode(deviceId);
    requireCalibrationCamera(deviceId, calibrationDrafts.get(deviceId)?.frame);
    const axis = String(input.axis ?? "").trim().toUpperCase();
    const distance = finiteCalibrationNumber(input.distance, "distance");
    if (!(["X", "Y"] as string[]).includes(axis) || distance === 0 || Math.abs(distance) > 10) {
      throw new PhonebaseApiError(
        "Calibration jogs must move X or Y by no more than 10 mm.",
        400,
        "INVALID_CALIBRATION_JOG",
      );
    }
    const currentX = finiteCalibrationNumber(grbl.x, "grbl.x");
    const currentY = finiteCalibrationNumber(grbl.y, "grbl.y");
    const x = axis === "X" ? currentX + distance : currentX;
    const y = axis === "Y" ? currentY + distance : currentY;
    const bounds = objectValue(grbl.calibrationMovementBounds);
    const minimumX = finiteCalibrationNumber(bounds.minimumX ?? 1, "calibrationMovementBounds.minimumX");
    const maximumX = finiteCalibrationNumber(bounds.maximumX ?? 82, "calibrationMovementBounds.maximumX");
    const minimumY = finiteCalibrationNumber(bounds.minimumY ?? 1, "calibrationMovementBounds.minimumY");
    const maximumY = finiteCalibrationNumber(bounds.maximumY ?? 170, "calibrationMovementBounds.maximumY");
    if (x < minimumX || x > maximumX || y < minimumY || y > maximumY) {
      throw new PhonebaseApiError(
        "The requested calibration jog is outside this device's safety envelope.",
        409,
        "CALIBRATION_JOG_OUT_OF_RANGE",
      );
    }
    const id = `calibration-jog-${randomUUID()}`;
    calibrationJogs.set(deviceId, { id, status: "executing", target: { x, y } });
    try {
      sendNodeEnvelope(node, { id, action: "jog", params: { x, y, mode: "calibration" } });
      const jog = await waitForCalibrationJog({
        id, target: { x, y },
        readNode: () => {
          const current = remoteNodes.get(deviceId);
          if (!current || current.socket !== node.socket || current.socket.readyState !== WebSocket.OPEN) return null;
          const grbl = objectValue(objectValue(current.state).grbl);
          const result = calibrationJogs.get(deviceId);
          return {
            grbl: result?.id === id && result.status === "failed"
              ? { ...grbl, lastOperation: { id, status: "failed", error: result.error } } : grbl,
            updatedAt: current.lastStateAt,
          };
        },
      });
      calibrationJogs.set(deviceId, jog);
      return calibrationState(deviceId);
    } catch (error) {
      const failed = error instanceof ManualCalibrationError && error.code === "CALIBRATION_JOG_FAILED";
      calibrationJogs.set(deviceId, { id, status: failed ? "failed" : "unconfirmed", target: { x, y }, error: errorMessage(error) });
      throw error;
    }
  }

  if (operation === "visual_recovery") {
    if (input.confirmation !== "TRUSTED_CAMERA_REFERENCE_MATCHED") {
      throw new PhonebaseApiError(
        "Trusted camera-reference confirmation is required.",
        409,
        "VERIFICATION_REQUIRED",
      );
    }
    const node = requireOnlineNode(deviceId);
    const state = objectValue(node.state);
    const grbl = objectValue(state.grbl);
    if (grbl.connected !== true) {
      throw new PhonebaseApiError(
        "The controller must be online before visual recovery.",
        409,
        "HARDWARE_OFFLINE",
      );
    }
    if (
      grbl.homed !== true ||
      grbl.state !== "Idle" ||
      grbl.activeOperation != null
    ) {
      throw new PhonebaseApiError(
        "Visual recovery requires an idle, homed controller.",
        409,
        "HOME_REQUIRED",
      );
    }
    if (!deviceFrame || !frameIsFresh(deviceFrame)) {
      throw new PhonebaseApiError(
        "A fresh physical camera frame is required for visual recovery.",
        409,
        "FRAME_UNAVAILABLE",
      );
    }

    let profile: PhonebaseCalibrationProfile;
    try {
      profile = parsePhonebaseCalibrationProfile(input.profile);
    } catch (error) {
      throw new PhonebaseApiError(
        error instanceof Error ? error.message : "The recovered profile is invalid.",
        400,
        "INVALID_CALIBRATION",
      );
    }
    const activeProfile = calibrationProfileFor(deviceId);
    if (
      !activeProfile ||
      profile.deviceId !== deviceId ||
      profile.id !== activeProfile.id
    ) {
      throw new PhonebaseApiError(
        "The recovered profile must match the active physical device profile.",
        409,
        "PROFILE_MISMATCH",
      );
    }
    if (
      profile.frame.width !== deviceFrame.frame.width ||
      profile.frame.height !== deviceFrame.frame.height
    ) {
      throw new PhonebaseApiError(
        "The recovered profile does not match the current camera resolution.",
        409,
        "FRAME_SIZE_MISMATCH",
      );
    }
    const geometryIssue = calibrationReadinessIssue({
      imagePoints: profile.imagePoints,
      machinePoints: profile.controlMachinePoints ?? profile.machinePoints,
    });
    if (geometryIssue) {
      throw new PhonebaseApiError(
        geometryIssue,
        409,
        "INVALID_CALIBRATION_GEOMETRY",
      );
    }

    const bounds = objectValue(grbl.movementBounds);
    const minimumX = finiteCalibrationNumber(bounds.minimumX, "movementBounds.minimumX");
    const maximumX = finiteCalibrationNumber(bounds.maximumX, "movementBounds.maximumX");
    const minimumY = finiteCalibrationNumber(bounds.minimumY, "movementBounds.minimumY");
    const maximumY = finiteCalibrationNumber(bounds.maximumY, "movementBounds.maximumY");
    const recoveredPoints = profile.controlMachinePoints ?? profile.machinePoints;
    if (recoveredPoints.some((point) =>
      point.x < minimumX || point.x > maximumX ||
      point.y < minimumY || point.y > maximumY
    )) {
      throw new PhonebaseApiError(
        "The recovered phone corners are outside the hardware movement envelope.",
        409,
        "CALIBRATION_OUT_OF_RANGE",
      );
    }
    if (
      profile.safeMachineBounds.minimumX < minimumX ||
      profile.safeMachineBounds.maximumX > maximumX ||
      profile.safeMachineBounds.minimumY < minimumY ||
      profile.safeMachineBounds.maximumY > maximumY
    ) {
      throw new PhonebaseApiError(
        "The recovered safe touch area is outside the hardware movement envelope.",
        409,
        "CALIBRATION_OUT_OF_RANGE",
      );
    }

    const outputPath = calibrationOutputPath(deviceId);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    calibrationProfile = profile;
    calibrationProfiles.set(deviceId, profile);
    runtime!.frameSyncMatchStreak = 0;
    runtime!.frameSyncLastCheckedAt = 0;
    scheduleFrameSyncCheck(deviceId);
    return calibrationState(deviceId);
  }

  const draft = calibrationDrafts.get(deviceId);
  if (!draft) {
    throw new PhonebaseApiError(
      "Begin a calibration session first.",
      409,
      "CALIBRATION_NOT_STARTED",
    );
  }
  const index = Number(input.index);
  if (!Number.isInteger(index) || index < 0 || index > 3) {
    throw new PhonebaseApiError(
      "Calibration point index must be 0–3.",
      400,
      "INVALID_CALIBRATION",
    );
  }

  if (operation === "capture_image_point") {
    requireCalibrationCamera(deviceId, draft.frame);
    const x = finiteCalibrationNumber(input.x, "x");
    const y = finiteCalibrationNumber(input.y, "y");
    if (x < 0 || x > draft.frame.width || y < 0 || y > draft.frame.height) {
      throw new PhonebaseApiError(
        "The camera point is outside the raw frame.",
        400,
        "INVALID_CALIBRATION",
      );
    }
    await persistCalibrationDraftChange(drafts => {
      const current = matchingCalibrationDraft(drafts, draft);
      const previous = current.imagePoints[index];
      const imagePoints = [...current.imagePoints], machinePoints = [...current.machinePoints];
      if (!previous || previous.x !== x || previous.y !== y) machinePoints[index] = null;
      imagePoints[index] = { x, y };
      drafts.set(deviceId, { ...current, imagePoints, machinePoints });
    });
    return calibrationState(deviceId);
  }

  if (operation === "capture_machine_point") {
    const { grbl } = requireCalibrationNode(deviceId);
    requireCalibrationCamera(deviceId, draft.frame);
    const x = finiteCalibrationNumber(grbl.x, "grbl.x");
    const y = finiteCalibrationNumber(grbl.y, "grbl.y");
    await persistCalibrationDraftChange(drafts => {
      const current = matchingCalibrationDraft(drafts, draft);
      const expectedImage = draft.imagePoints[index], currentImage = current.imagePoints[index];
      if (expectedImage?.x !== currentImage?.x || expectedImage?.y !== currentImage?.y) {
        throw new PhonebaseApiError("This camera corner changed while capturing XY. Verify the matching corner and capture again.", 409, "CALIBRATION_DRAFT_CHANGED");
      }
      assertMachinePointCapture(current, index, { x, y });
      const machinePoints = [...current.machinePoints];
      machinePoints[index] = { x, y };
      drafts.set(deviceId, { ...current, machinePoints });
    });
    return calibrationState(deviceId);
  }

  if (operation === "activate") {
    const { grbl } = requireCalibrationNode(deviceId);
    requireCalibrationCamera(deviceId, draft.frame);
    if (!draft.imagePoints.every(Boolean) || !draft.machinePoints.every(Boolean)) {
      throw new PhonebaseApiError(
        "All four camera points and machine points are required.",
        409,
        "CALIBRATION_INCOMPLETE",
      );
    }
    if (input.confirmation !== "PHONE_FIXED_AND_POINTS_VERIFIED") {
      throw new PhonebaseApiError(
        "Physical fixture verification confirmation is required.",
        409,
        "VERIFICATION_REQUIRED",
      );
    }
    const machinePoints = draft.machinePoints as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];
    const geometryIssue = calibrationReadinessIssue({
      imagePoints: draft.imagePoints,
      machinePoints: draft.machinePoints,
    });
    if (geometryIssue) {
      throw new PhonebaseApiError(
        geometryIssue,
        409,
        "INVALID_CALIBRATION_GEOMETRY",
      );
    }
    const xs = machinePoints.map((point) => point.x);
    const ys = machinePoints.map((point) => point.y);
    const tapProfile = objectValue(grbl.tapProfile);
    const touchBounds = objectValue(grbl.movementBounds);
    const minimumTouchX = finiteCalibrationNumber(
      touchBounds.minimumX,
      "movementBounds.minimumX",
    );
    const maximumTouchX = finiteCalibrationNumber(
      touchBounds.maximumX,
      "movementBounds.maximumX",
    );
    const minimumTouchY = finiteCalibrationNumber(
      touchBounds.minimumY,
      "movementBounds.minimumY",
    );
    const maximumTouchY = finiteCalibrationNumber(
      touchBounds.maximumY,
      "movementBounds.maximumY",
    );
    const reportedProfileId = String(tapProfile.id ?? "").trim();
    const profileId = reportedProfileId &&
        !/^(?:unconfigured|placeholder|default)$/i.test(reportedProfileId)
      ? reportedProfileId
      : `phonebase-${deviceId.replace(/[^a-zA-Z0-9._-]/g, "_")}-physical-v1`;
    const profileInput = {
      id: profileId,
      deviceId,
      verified: true,
      verifiedAt: new Date().toISOString(),
      frame: { width: draft.frame.width, height: draft.frame.height },
      screen: draft.screen,
      imagePoints: draft.imagePoints,
      machinePoints,
      ...(draft.screen.height / draft.screen.width >= 1.8
        ? {
            navigation: {
              home: {
                strategy: "screen-swipe" as const,
                startPoint: {
                  x: draft.screen.width / 2,
                  y: Math.round(draft.screen.height * 0.981),
                },
                endPoint: {
                  x: draft.screen.width / 2,
                  y: Math.round(draft.screen.height * 0.795),
                },
                durationMs: 250,
                source: "ios-face-id-home-v1" as const,
              },
            },
          }
        : {}),
      safeMachineBounds: {
        minimumX: Math.max(Math.min(...xs) + 0.5, minimumTouchX),
        maximumX: Math.min(Math.max(...xs) - 0.5, maximumTouchX),
        minimumY: Math.max(Math.min(...ys) + 0.5, minimumTouchY),
        maximumY: Math.min(Math.max(...ys) - 0.5, maximumTouchY),
      },
      tap: {
        hoverZ: finiteCalibrationNumber(tapProfile.hoverZ ?? 0, "tapProfile.hoverZ"),
        touchZ: finiteCalibrationNumber(
          tapProfile.minimumTouchZ ?? tapProfile.touchZ ?? 4,
          "tapProfile.minimumTouchZ",
        ),
        zStep: 0.5,
        feed: 3000,
        dwellMs: 40,
      },
    };
    const profile = parsePhonebaseCalibrationProfile(profileInput);
    const outputPath = calibrationOutputPath(deviceId);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(profile, null, 2)}\n`,
      "utf8",
    );
    calibrationProfile = profile;
    calibrationProfiles.set(deviceId, profile);
    await persistCalibrationDraftChange(drafts => {
      matchingCalibrationDraft(drafts, draft);
      drafts.delete(deviceId);
    });
    return calibrationState(deviceId);
  }

  throw new PhonebaseApiError(
    `Unsupported calibration operation: ${operation}`,
    400,
    "INVALID_CALIBRATION",
  );
}

const publishing = new PublishingService(`http://127.0.0.1:${PORT}`, CONTROL_PLANE_TOKEN);
const server = createServer(async (request, response) => {
  request.headers["x-request-id"] = boundedHeader(
    request.headers["x-request-id"],
    randomUUID(),
    160,
  );
  if (request.method === "OPTIONS") {
    setHeaders(request, response, 204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const requestStarted = performance.now();
  response.once("finish", () => {
    if (url.pathname === "/api/frame/jpeg" || url.pathname.startsWith("/api/v1/admin/observability")) return;
    const durationMs = performance.now() - requestStarted;
    observability.record({kind:"http.request", source:clientSource(request.headers["x-phonebase-client"]),
      actor:boundedHeader(request.headers["x-phonebase-actor"], "local-api", 120),
      requestId:String(request.headers["x-request-id"]), deviceId:url.pathname.match(/^\/api\/v1\/devices\/([^/]+)/)?.[1],
      status:String(response.statusCode), level:response.statusCode>=500?"error":response.statusCode>=400?"warning":"info", durationMs,
      details:{method:request.method, path:url.pathname, code:response.getHeader("X-Phonebase-Error-Code")}});
  });

  try {
    if (!requestIsAuthorized(request)) {
      throw new PhonebaseApiError("A valid local control-plane bearer token is required.", 401, "UNAUTHORIZED");
    }
    if (url.pathname.startsWith("/api/v1/publishing")) {
      setHeaders(request, response);
      if (await publishing.handle(request, response, url)) return;
    }
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      ["/touch-calibration", "/touch-calibration.html"].includes(url.pathname)
    ) {
      const html = await readFile(TOUCH_CALIBRATION_PAGE_URL, "utf8");
      setHeaders(request, response, 200, "text/html; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }

    if (url.pathname === "/api/touch-calibration/samples") {
      if (request.method === "GET") {
        sendJson(request, response, {
          ok: true,
          samples: touchCalibrationSamples,
        });
        return;
      }
      if (request.method === "DELETE") {
        touchCalibrationSamples.length = 0;
        sendJson(request, response, { ok: true, samples: [] });
        return;
      }
      if (request.method === "POST") {
        touchCalibrationHeartbeatAt = Date.now();
        const input = objectValue(await readJson<unknown>(request));
        const x = finiteCalibrationNumber(input.x, "x");
        const y = finiteCalibrationNumber(input.y, "y");
        const viewportWidth = finiteCalibrationNumber(
          input.viewportWidth,
          "viewportWidth",
        );
        const viewportHeight = finiteCalibrationNumber(
          input.viewportHeight,
          "viewportHeight",
        );
        const screenX = finiteCalibrationNumber(input.screenX, "screenX");
        const screenY = finiteCalibrationNumber(input.screenY, "screenY");
        const screenWidth = finiteCalibrationNumber(input.screenWidth, "screenWidth");
        const screenHeight = finiteCalibrationNumber(input.screenHeight, "screenHeight");
        if (
          input.coordinateSpaceVersion !== 2 ||
          viewportWidth < 100 || viewportWidth > 4096 ||
          viewportHeight < 100 || viewportHeight > 4096 ||
          screenWidth < 100 || screenWidth > 4096 ||
          screenHeight < 100 || screenHeight > 4096 ||
          x < 0 || x > viewportWidth || y < 0 || y > viewportHeight ||
          screenX < 0 || screenX > screenWidth ||
          screenY < 0 || screenY > screenHeight
        ) {
          throw new PhonebaseApiError(
            "Touch sample is outside the reported viewport.",
            400,
            "INVALID_TOUCH_SAMPLE",
          );
        }
        const sample: TouchCalibrationSample = {
          id: ++touchCalibrationSampleId,
          x,
          y,
          normalizedX: x / viewportWidth,
          normalizedY: y / viewportHeight,
          viewportWidth,
          viewportHeight,
          screenX,
          screenY,
          screenWidth,
          screenHeight,
          normalizedScreenX: screenX / screenWidth,
          normalizedScreenY: screenY / screenHeight,
          coordinateSpaceVersion: 2,
          pointerType: String(input.pointerType ?? "touch").slice(0, 24),
          capturedAt: Date.now(),
        };
        touchCalibrationSamples.push(sample);
        while (touchCalibrationSamples.length > 512) {
          touchCalibrationSamples.shift();
        }
        sendJson(request, response, { ok: true, sample }, 201);
        return;
      }
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/touch-calibration/profile"
    ) {
      if (!requestIsLoopback(request)) {
        throw new PhonebaseApiError(
          "Touch profile activation is restricted to the local recovery gateway.",
          403,
          "LOCAL_ONLY",
        );
      }
      if (Date.now() - touchCalibrationHeartbeatAt > TOUCH_CALIBRATION_HEARTBEAT_MS) {
        throw new PhonebaseApiError(
          "The dedicated touch-calibration page must remain active.",
          409,
          "TOUCH_PAGE_INACTIVE",
        );
      }
      const input = objectValue(await readJson<unknown>(request));
      if (input.confirmation !== "TOUCH_PAGE_POINTS_VERIFIED") {
        throw new PhonebaseApiError(
          "Verified touch-point confirmation is required.",
          409,
          "VERIFICATION_REQUIRED",
        );
      }
      const profile = parsePhonebaseCalibrationProfile(input.profile);
      const activeProfile = calibrationProfileFor(profile.deviceId);
      if (
        !activeProfile ||
        profile.id !== activeProfile.id
      ) {
        throw new PhonebaseApiError(
          "The learned touch profile must match the active hardware profile.",
          409,
          "PROFILE_MISMATCH",
        );
      }
      const outputPath = calibrationOutputPath(profile.deviceId);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(
        outputPath,
        `${JSON.stringify(profile, null, 2)}\n`,
        "utf8",
      );
      calibrationProfile = profile;
      calibrationProfiles.set(profile.deviceId, profile);
      const runtime = deviceFrameRuntime(profile.deviceId);
      runtime.frameSyncMatchStreak = 0;
      runtime.frameSyncLastCheckedAt = 0;
      scheduleFrameSyncCheck(profile.deviceId);
      sendJson(request, response, {
        ok: true,
        calibration: calibrationState(profile.deviceId),
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/touch-calibration/heartbeat"
    ) {
      touchCalibrationHeartbeatAt = Date.now();
      sendJson(request, response, {
        ok: true,
        activeUntil: touchCalibrationHeartbeatAt + TOUCH_CALIBRATION_HEARTBEAT_MS,
      });
      return;
    }

    if (request.method === "GET" && ["/", "/health", "/api/status"].includes(url.pathname)) {
      const currentFrameAgeMs = frameAgeMs(latestFrame);
      const currentFrameFresh = frameIsFresh(latestFrame);
      const physicalTapReady = phonebaseDeviceIds().some(
        (deviceId) => tapReadiness(deviceId).ready,
      );
      sendJson(request, response, {
        ok: true,
        service: "Phonebase physical-device control plane",
        ready: true,
        frame: publicFrame(latestFrame),
        frameFresh: currentFrameFresh,
        frameAgeMs: currentFrameAgeMs,
        actionGate: {
          observation: currentFrameFresh,
          physicalTap: physicalTapReady,
          ...(!currentFrameFresh
            ? { reason: "Waiting for a fresh camera frame." }
            : !physicalTapReady
              ? { reason: "Waiting for a matching four-point map, touch profile, and local hardware unlock." }
              : {}),
        },
        nodes: publicNodes(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/nodes") {
      sendJson(request, response, {
        ok: true,
        nodes: publicNodes(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/openapi.json") {
      const specification = JSON.parse(await readFile(OPENAPI_URL, "utf8")) as Record<string, unknown>;
      sendJson(request, response, specification);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/admin/video-focus") {
      if (!requestIsLocalDashboard(request)) throw new PhonebaseApiError("Video switching is available only to the local station operator.", 403, "LOCAL_ONLY");
      const input = objectValue(await readJson<unknown>(request));
      const deviceId = String(input.deviceId ?? "").trim();
      if (!deviceId || deviceId.length > 120 || !publicPhonebaseDeviceById(deviceId)?.connected) throw new PhonebaseApiError("Select a connected camera device.", 400, "INVALID_DEVICE");
      const video = await focusDeviceVideo(deviceId);
      sendJson(request, response, { ok: true, video });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/admin/fleet-discovery") {
      if (!requestIsLocalDashboard(request) || request.headers["x-phonebase-actor"]?.toString().startsWith("rental:") ||
        request.headers["x-forwarded-for"] || request.headers["forwarded"]) {
        throw new PhonebaseApiError("Hardware discovery is available only to the local station operator.", 403, "LOCAL_ONLY");
      }
      const live = [...remoteNodes.values()].map(node => {
        const device = publicPhonebaseDevice(node);
        return { id: node.deviceId, connected: device.connected,
          liveVideo: device.capabilities.observation.liveFrames.available };
      });
      sendJson(request, response, { ok: true, discovery: readFleetDiscoveryView(FLEET_DISCOVERY_PATH, live) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/devices") {
      sendJson(request, response, {
        ok: true,
        protocolVersion: PHONEBASE_PROTOCOL_VERSION,
        devices: phonebaseDeviceIds()
          .map(publicPhonebaseDeviceById)
          .filter(Boolean),
      });
      return;
    }

    if (url.pathname.startsWith("/api/v1/admin/agent-lab")) {
      if (!requestIsLocalDashboard(request)) {
        throw new PhonebaseApiError(
          "Agent Lab is available only to the local station Dashboard.",
          403,
          "LOCAL_ONLY",
        );
      }
      if (request.method === "GET" && url.pathname === "/api/v1/admin/agent-lab/config") {
        const configured = await configuredOpenRouterKey();
        sendJson(request, response, {
          ok: true,
          configured: Boolean(configured),
          source: configured?.source ?? null,
          model: OPENROUTER_JEV_MODEL,
          plannerModel: PHONE_AGENT_MODEL,
          mode: "agent",
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/admin/agent-lab/config") {
        const input = objectValue(await readJson<unknown>(request));
        await saveOpenRouterKey(String(input.apiKey ?? "").trim());
        sendJson(request, response, {
          ok: true,
          configured: true,
          source: "local-file",
          model: OPENROUTER_JEV_MODEL,
          plannerModel: PHONE_AGENT_MODEL,
          mode: "agent",
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/admin/agent-lab/tasks") {
        const tasks = [...agentTasks.values()]
          .sort((left, right) => right.createdAt - left.createdAt)
          .slice(0, 20)
          .map(publicAgentTask);
        sendJson(request, response, { ok: true, tasks });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/admin/agent-lab/tasks") {
        const input = objectValue(await readJson<unknown>(request));
        const deviceId = String(input.deviceId ?? "").trim();
        const goal = String(input.goal ?? "").trim();
        if (!publicPhonebaseDeviceById(deviceId)) {
          throw new PhonebaseApiError("Select a connected Phonebase device.", 400, "INVALID_DEVICE");
        }
        if (!goal || goal.length > 500) {
          throw new PhonebaseApiError(
            "Describe the complete phone task in 1 to 500 characters.",
            400,
            "INVALID_AGENT_GOAL",
          );
        }
        if (input.confirmed !== true) {
          throw new PhonebaseApiError(
            "Confirm that the physical workspace is clear and that the written task authorizes its stated external effects.",
            409,
            "AGENT_CONFIRMATION_REQUIRED",
          );
        }
        if (!await configuredOpenRouterKey()) {
          throw new PhonebaseApiError(
            "Configure an OpenRouter key in Agent Lab before running a task.",
            409,
            "OPENROUTER_NOT_CONFIGURED",
          );
        }
        if (agentBusyDevices.has(deviceId) || recorderBusyDevices.has(deviceId) || publishing.busy(deviceId)) {
          throw new PhonebaseApiError(
            "This device is already executing another workflow.",
            409,
            "DEVICE_BUSY",
          );
        }
        const now = Date.now();
        const task: AgentTask = {
          id: randomUUID(),
          deviceId,
          goal,
          status: "running",
          createdAt: now,
          updatedAt: now,
          model: PHONE_AGENT_MODEL,
          maxSteps: Number.isSafeInteger(PHONE_AGENT_MAX_STEPS) && PHONE_AGENT_MAX_STEPS >= 12 && PHONE_AGENT_MAX_STEPS <= 80
            ? PHONE_AGENT_MAX_STEPS
            : 36,
          budgetUsd: Number.isFinite(PHONE_AGENT_BUDGET_USD) && PHONE_AGENT_BUDGET_USD > 0
            ? PHONE_AGENT_BUDGET_USD
            : 0.50,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          steps: [],
          summary: "Inspecting the current phone screen…",
          error: "",
          stopRequested: false,
        };
        agentTasks.set(task.id, task);
        const oldest = [...agentTasks.values()].sort((left, right) => right.createdAt - left.createdAt).slice(20);
        for (const stale of oldest) {
          if (stale.status !== "running") agentTasks.delete(stale.id);
        }
        void runPhoneAgentTask(task);
        sendJson(request, response, { ok: true, task: publicAgentTask(task) }, 202);
        return;
      }
      const agentStopRoute = url.pathname.match(/^\/api\/v1\/admin\/agent-lab\/tasks\/([^/]+)\/stop$/);
      if (request.method === "POST" && agentStopRoute) {
        const task = agentTasks.get(decodeURIComponent(agentStopRoute[1]));
        if (!task) throw new PhonebaseApiError("Agent task not found.", 404, "AGENT_TASK_NOT_FOUND");
        if (task.status === "running") {
          task.stopRequested = true;
          task.summary = "Stop requested; waiting for the current physical action to finish safely.";
          task.updatedAt = Date.now();
        }
        sendJson(request, response, { ok: true, task: publicAgentTask(task) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/admin/agent-lab/locate") {
        const input = objectValue(await readJson<unknown>(request));
        const deviceId = String(input.deviceId ?? "").trim();
        const target = String(input.target ?? "").trim();
        if (!target || target.length > 120) {
          throw new PhonebaseApiError(
            "Describe one visible target in 1 to 120 characters.",
            400,
            "INVALID_AGENT_TARGET",
          );
        }
        if (!publicPhonebaseDeviceById(deviceId)) {
          throw new PhonebaseApiError("Select a connected Phonebase device.", 400, "INVALID_DEVICE");
        }
        const configured = await configuredOpenRouterKey();
        if (!configured) {
          throw new PhonebaseApiError(
            "Configure an OpenRouter key in Agent Lab before running a model.",
            409,
            "OPENROUTER_NOT_CONFIGURED",
          );
        }
        const stored = existingDeviceFrameRuntime(deviceId)?.latestFrame ?? null;
        if (!stored || !frameIsFresh(stored)) {
          throw new PhonebaseApiError(
            "A fresh phone frame is required for Agent Lab.",
            409,
            "FRAME_UNAVAILABLE",
          );
        }
        const geometry = frameGeometry(stored);
        if (!geometry) {
          throw new PhonebaseApiError(
            "The current frame cannot be mapped to the calibrated phone screen.",
            409,
            "FRAME_GEOMETRY_UNAVAILABLE",
          );
        }
        const canonical = await renderModelScreenFrame(stored.bytes, geometry, 1_568);
        const imageDataUrl = `data:image/jpeg;base64,${canonical.bytes.toString("base64")}`;
        const startedAt = performance.now();
        const upstream = await fetch(OPENROUTER_DECISIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${configured.key}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://127.0.0.1:3020",
            "X-OpenRouter-Title": "PhoneUse Agent Lab",
          },
          body: JSON.stringify(buildJevLocateRequest(target, imageDataUrl)),
          signal: AbortSignal.timeout(30_000),
        });
        if (!upstream.ok) {
          const upstreamError = objectValue(await upstream.json().catch(() => ({})));
          const errorRecord = objectValue(upstreamError.error);
          const message = String(errorRecord.message ?? upstreamError.message ?? "").slice(0, 240);
          throw new PhonebaseApiError(
            message || `OpenRouter returned ${upstream.status}.`,
            502,
            "OPENROUTER_ERROR",
          );
        }
        const located = parseJevLocateResponse(await upstream.json());
        const qualification = qualifyJevActionCandidate({
          visibleProbability: located.visibleProbability,
          confidence: located.confidence,
          box: located.box,
        });
        sendJson(request, response, {
          ok: true,
          mode: "shadow",
          deviceId,
          target,
          frameSequence: stored.sequence,
          capturedAt: stored.frame.capturedAt,
          image: {
            dataUrl: imageDataUrl,
            width: canonical.imageWidth,
            height: canonical.imageHeight,
          },
          result: located,
          policy: {
            safeToAct: qualification.safeToAct,
            executed: false,
            qualifiedBy: qualification.qualifiedBy,
            plannerAgreement: qualification.plannerAgreement,
            boxArea: qualification.boxArea,
            reason: qualification.safeToAct
              ? "Qualified by the same guarded policy used by Agent tasks; Shadow mode never clicks."
              : "Below the Agent visibility, confidence, or target-size policy; no action is allowed.",
          },
          latencyMs: Math.round(performance.now() - startedAt),
        });
        return;
      }
    }

    if (url.pathname.startsWith("/api/v1/admin/recorder")) {
      if (!requestIsLocalDashboard(request)) {
        throw new PhonebaseApiError(
          "Recorder workflows are available only to the local station Dashboard.",
          403,
          "LOCAL_ONLY",
        );
      }
      if (request.method === "GET" && url.pathname === "/api/v1/admin/recorder") {
        sendJson(request, response, { ok: true, ...recorder.snapshot() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/admin/recorder/sessions") {
        const input = objectValue(await readJson<unknown>(request));
        const deviceId = String(input.deviceId ?? "").trim();
        const name = String(input.name ?? "").trim();
        if (!deviceId || deviceId.length > 120 || !publicPhonebaseDeviceById(deviceId)) {
          throw new PhonebaseApiError("Select a connected Phonebase device.", 400, "INVALID_DEVICE");
        }
        if (name.length > 120) {
          throw new PhonebaseApiError("Recording name is too long.", 400, "INVALID_NAME");
        }
        const session = await recorder.start(deviceId, name);
        sendJson(request, response, { ok: true, session }, 201);
        return;
      }
      const sessionRoute = url.pathname.match(
        /^\/api\/v1\/admin\/recorder\/sessions\/([^/]+)\/(stop|discard)$/,
      );
      if (request.method === "POST" && sessionRoute) {
        const sessionId = decodeURIComponent(sessionRoute[1]);
        if (sessionRoute[2] === "discard") {
          await recorder.discard(sessionId);
          sendJson(request, response, { ok: true });
          return;
        }
        const input = objectValue(await readJson<unknown>(request));
        const name = String(input.name ?? "").trim();
        if (name.length > 120) {
          throw new PhonebaseApiError("Recording name is too long.", 400, "INVALID_NAME");
        }
        const workflow = await recorder.stop(sessionId, name);
        sendJson(request, response, { ok: true, workflow });
        return;
      }
      const workflowRoute = url.pathname.match(
        /^\/api\/v1\/admin\/recorder\/workflows\/([^/]+)\/(run|delete)$/,
      );
      if (request.method === "POST" && workflowRoute) {
        const workflowId = decodeURIComponent(workflowRoute[1]);
        if (workflowRoute[2] === "delete") {
          await recorder.deleteWorkflow(workflowId);
          sendJson(request, response, { ok: true });
          return;
        }
        const input = objectValue(await readJson<unknown>(request));
        if (input.confirmed !== true) {
          throw new PhonebaseApiError(
            "Replay requires confirmation that the phone and arm workspace are ready.",
            409,
            "REPLAY_CONFIRMATION_REQUIRED",
          );
        }
        const workflow = recorder.workflow(workflowId);
        if (!workflow) {
          throw new PhonebaseApiError("Recorded workflow not found.", 404, "WORKFLOW_NOT_FOUND");
        }
        const run = await replayRecordedWorkflow(workflow);
        sendJson(request, response, { ok: true, run });
        return;
      }
    }
    if (url.pathname.startsWith("/api/v1/admin/observability")) {
      if (!requestIsLocalDashboard(request) || request.headers["x-phonebase-actor"]?.toString().startsWith("rental:"))
        throw new PhonebaseApiError("Activity and incident records are available only to the local administrator.", 403, "LOCAL_ONLY");
      if (request.method === "GET") {
        const registry=await readRentalLeaseRegistry(RENTAL_LEASES_PATH);
        sendJson(request, response, {ok:true, ...await observability.summary(), ...await observability.query(url.searchParams),
          customers:registry.leases.map(lease=>({id:lease.id,customer:lease.customer}))});
        return;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/v1/admin/observability/incidents/resolve") {
      const input=objectValue(await readJson<unknown>(request));
      if(typeof input.key!=="string" || input.key.length>240)throw new PhonebaseApiError("Invalid incident",400,"INVALID_INCIDENT");
      observability.flag(input.key,false,"Reviewed by local administrator");
      observability.record({kind:"admin.incident_reviewed",source:"dashboard",actor:"local-admin",details:{key:input.key}});
      sendJson(request,response,{ok:true});return;
    }
    if (request.method === "POST" && /^\/api\/v1\/devices\/[^/]+\/telemetry$/.test(url.pathname)) {
      const deviceId=decodeURIComponent(url.pathname.split("/")[4]);
      const input=objectValue(await readJson<unknown>(request));
      const allowed=new Set(["ui.navigation","ui.control","ui.view","ui.interaction","ui.setup","client.request","stream.quality","client.error"]);
      if (!allowed.has(String(input.kind))) throw new PhonebaseApiError("Unknown telemetry event",400,"INVALID_TELEMETRY");
      const number=(key:string) => typeof input[key]==="number" && Number.isFinite(input[key]) ? Math.max(0,Math.min(120000,input[key] as number)) : undefined;
      const context=actionRequestContext(request);
      observability.record({kind:String(input.kind), actor:context.actor, source:context.source, deviceId,
        requestId:typeof input.requestId==="string"?requestIdentity(input.requestId):context.requestId,
        durationMs:number("durationMs"), status:String(input.status??"").slice(0,60),
        level:input.kind==="client.error"?"error":"info", details:{reportedByClient:true,
          view:String(input.view??"").slice(0,60), control:String(input.control??"").slice(0,100), code:String(input.code??"").slice(0,60),
          frameAgeMs:number("frameAgeMs"), fps:number("fps"), decodeMs:number("decodeMs"), samples:number("samples")}});
      const age=number("frameAgeMs");
      if(input.kind==="stream.quality" && age!==undefined && (number("samples")??0)>=10)
        observability.flag(`client-latency:${context.actor}:${deviceId}`,age>1000,"Customer reports delayed video",deviceId,{actor:context.actor,frameAgeMs:age,reportedByClient:true});
      sendJson(request,response,{ok:true},202); return;
    }
    if (url.pathname.startsWith("/api/v1/admin/rentals")) {
      if (!requestIsLocalDashboard(request)) {
        throw new PhonebaseApiError(
          "Rental management is available only from the local station Dashboard.",
          403,
          "LOCAL_ONLY",
        );
      }
      if (request.method === "GET" && url.pathname === "/api/v1/admin/rentals") {
        sendJson(request, response, {
          ok: true,
          ...(await rentalAdminSnapshot()),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/admin/rentals") {
        const input = objectValue(await readJson<unknown>(request));
        const deviceIds = input.deviceIds ?? [input.deviceId];
        if (!Array.isArray(deviceIds) || deviceIds.length < 1 || deviceIds.length > 100 ||
          deviceIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,120}$/.test(id)) ||
          new Set(deviceIds).size !== deviceIds.length) {
          throw new PhonebaseApiError("Choose 1–100 unique devices.", 400, "INVALID_DEVICES");
        }
        const customer = String(input.customer ?? "").trim();
        if (deviceIds.some(id => !publicPhonebaseDeviceById(id)?.connected)) {
          throw new PhonebaseApiError(
            "Choose a currently connected Phonebase device.",
            409,
            "DEVICE_NOT_CONNECTED",
          );
        }
        const settings = rentalAccessSettings();
        const created = await mutateRentalRegistry(async () => {
          const registry = await readRentalLeaseRegistry(RENTAL_LEASES_PATH);
          const next = createRentalLease(registry, { deviceIds, customer, months: 1 });
          await writeRentalLeaseRegistry(RENTAL_LEASES_PATH, next.registry);
          return next;
        });
        sendJson(request, response, {
          ok: true,
          lease: rentalLeaseView(created.lease, settings),
        }, 201);
        return;
      }
      const rentalMutationMatch = url.pathname.match(
        /^\/api\/v1\/admin\/rentals\/([^/]+)\/(renew|revoke)$/,
      );
      if (request.method === "POST" && rentalMutationMatch) {
        const leaseId = decodeURIComponent(rentalMutationMatch[1]);
        const operation = rentalMutationMatch[2];
        const settings = operation === "renew" ? rentalAccessSettings() : null;
        const changed = await mutateRentalRegistry(async () => {
          const registry = await readRentalLeaseRegistry(RENTAL_LEASES_PATH);
          const next = operation === "renew"
            ? renewRentalLease(registry, leaseId, 1)
            : revokeRentalLease(registry, leaseId);
          await writeRentalLeaseRegistry(RENTAL_LEASES_PATH, next.registry);
          return next;
        });
        sendJson(request, response, {
          ok: true,
          lease: rentalLeaseView(changed.lease, settings),
        });
        return;
      }
      throw new PhonebaseApiError(
        "Rental management route was not found.",
        404,
        "NOT_FOUND",
      );
    }

    const actionReceiptMatch = url.pathname.match(
      /^\/api\/v1\/devices\/([^/]+)\/actions\/([^/]+)$/,
    );
    if (request.method === "GET" && actionReceiptMatch) {
      const deviceId = decodeURIComponent(actionReceiptMatch[1]);
      const receiptId = decodeURIComponent(actionReceiptMatch[2]);
      const receipt = actionReceipts.get(receiptId);
      if (!receipt || receipt.deviceId !== deviceId) {
        throw new PhonebaseApiError(
          `Action receipt is unknown: ${receiptId}`,
          404,
          "ACTION_NOT_FOUND",
        );
      }
      sendJson(request, response, {
        ok: true,
        protocolVersion: PHONEBASE_PROTOCOL_VERSION,
        receipt: publicActionReceipt(receipt),
      });
      return;
    }

    const semanticDeviceMatch = url.pathname.match(
      /^\/api\/v1\/devices\/([^/]+)(?:\/(screenshot|screen-state|actions|visual-actions|calibration))?$/,
    );
    if (semanticDeviceMatch) {
      const deviceId = decodeURIComponent(semanticDeviceMatch[1]);
      const resource = semanticDeviceMatch[2] ?? "device";

      if (request.method === "GET" && resource === "screen-state") {
        if (!publicPhonebaseDeviceById(deviceId)) throw new PhonebaseApiError("Unknown device",404,"DEVICE_NOT_FOUND");
        const text = url.searchParams.get("text") ?? undefined;
        const match = url.searchParams.get("match") ?? "contains";
        const region = url.searchParams.get("region") ?? "all";
        const keyboard = url.searchParams.get("keyboard");
        let bounds: Record<string,unknown> | undefined;
        if (url.searchParams.has("bounds")) {
          try { bounds=objectValue(JSON.parse(url.searchParams.get("bounds")!)); }
          catch { throw new PhonebaseApiError("bounds must be a normalized JSON rectangle",400,"INVALID_SCREEN_EXPECTATION"); }
        }
        const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? 0);
        const afterSequence = Number(url.searchParams.get("afterSequence") ?? 0);
        const afterCapturedAt = Number(url.searchParams.get("afterCapturedAt") ?? 0);
        if ((text !== undefined && (!text.length || text.length > 120)) || !["exact","contains"].includes(match) ||
          !["all","top","input"].includes(region) || (keyboard !== null && !["true","false"].includes(keyboard)) ||
          !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10000 || !Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(afterCapturedAt) || afterCapturedAt < 0) {
          throw new PhonebaseApiError("Invalid bounded screen expectation",400,"INVALID_SCREEN_EXPECTATION");
        }
        if (bounds && (!["left","top","right","bottom"].every(k=>typeof bounds[k] === "number" && Number.isFinite(bounds[k]) && Number(bounds[k])>=0 && Number(bounds[k])<=1) || Number(bounds.left)>=Number(bounds.right) || Number(bounds.top)>=Number(bounds.bottom))) throw new PhonebaseApiError("Invalid screen bounds",400,"INVALID_SCREEN_EXPECTATION");
        const expected: ScreenExpectation = {text,match:match as "exact"|"contains",region:region as "all"|"top"|"input",
          ...(keyboard === null ? {} : {keyboard:keyboard === "true"}),...(bounds ? {bounds:bounds as ScreenExpectation["bounds"]} : {})};
        const deadline = Date.now() + timeoutMs;
        let last: Record<string,unknown> = {matched:false,reason:"No fresh synchronized frame"};
        let previousSequence = 0, consecutiveMatches = 0;
        do {
          const stored = existingDeviceFrameRuntime(deviceId)?.latestFrame;
          const device = publicPhonebaseDeviceById(deviceId);
          const sync = objectValue(objectValue(device?.state).screenSync);
          if (stored && frameIsFresh(stored) && stored.sequence > afterSequence && stored.frame.capturedAt >= afterCapturedAt && stored.sequence !== previousSequence && sync.status === "synchronized") {
            previousSequence = stored.sequence;
            const ocr = await recognizeVisionText(`data:${stored.mimeType};base64,${stored.bytes.toString("base64")}`);
            let verificationOcr = ocr;
            if (expected.bounds) {
              const left=Math.floor(expected.bounds.left*stored.frame.width),top=Math.floor(expected.bounds.top*stored.frame.height);
              const width=Math.max(1,Math.floor(expected.bounds.right*stored.frame.width)-left),height=Math.max(1,Math.floor(expected.bounds.bottom*stored.frame.height)-top);
              const crop=await sharp(stored.bytes).extract({left,top,width,height}).resize(width*2,height*2).jpeg({quality:95}).toBuffer();
              const regionOcr=await recognizeVisionText(`data:image/jpeg;base64,${crop.toString("base64")}`);
              const sx=width/regionOcr.imageWidth,sy=height/regionOcr.imageHeight;
              verificationOcr={...ocr,items:regionOcr.items.map(i=>({...i,left:i.left*sx+left,top:i.top*sy+top,centerX:i.centerX*sx+left,centerY:i.centerY*sy+top,width:i.width*sx,height:i.height*sy}))};
            }
            const evaluated = evaluateScreenExpectation(verificationOcr,expected,looksLikeIosKeyboard(ocr) || iosEnglishKeyboardVisible(stored.bytes));
            consecutiveMatches = evaluated.matched ? consecutiveMatches + 1 : 0;
            last = {...evaluated,frameSequence:stored.sequence,capturedAt:stored.frame.capturedAt,
              frameWidth:stored.frame.width,frameHeight:stored.frame.height,synchronized:true,
              homeVisible:homeScreenGridVisible(ocr),visibleBlockers:visibleAccessBlockers(ocr),consecutiveMatches};
            if (timeoutMs === 0 || consecutiveMatches >= 2) break;
          } else if (!stored || !frameIsFresh(stored) || sync.status !== "synchronized") { consecutiveMatches = 0; }
          if (Date.now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve,150));
        } while (Date.now() <= deadline);
        const verified = (text !== undefined || keyboard !== null) && last.matched === true && (timeoutMs === 0 || consecutiveMatches >= 2);
        sendJson(request,response,{ok:true,protocolVersion:PHONEBASE_PROTOCOL_VERSION,deviceId,
          expected,typing:{layout:"ios-English-portrait-720x1560",supportedCharacters:IOS_ENGLISH_SUPPORTED_CHARACTERS,
            requiresVisibleAlphabetKeyboard:true,strictDeviceOverridesMayRestrictCharacters:true},verification:{...last,status:verified ? "matched" : "not_matched",matched:verified,
            scope:"visible_screen_postcondition",physicalActionSent:false}});
        return;
      }

      if (request.method === "GET" && resource === "device") {
        const device = publicPhonebaseDeviceById(deviceId);
        if (!device) {
          throw new PhonebaseApiError(
            `Phonebase device is unknown: ${deviceId}`,
            404,
            "DEVICE_NOT_FOUND",
          );
        }
        if (url.searchParams.get("source") === "camera") {
          device.screen = publicFrame(existingDeviceFrameRuntime(deviceId)?.latestVerificationFrame ?? null);
        }
        sendJson(request, response, {
          ok: true,
          protocolVersion: PHONEBASE_PROTOCOL_VERSION,
          device,
        });
        return;
      }

      if (request.method === "GET" && resource === "screenshot") {
        const deviceRuntime = existingDeviceFrameRuntime(deviceId);
        const cameraOnly = url.searchParams.get("source") === "camera";
        const currentFrame = cameraOnly ? deviceRuntime?.latestVerificationFrame : deviceRuntime?.latestFrame;
        const requestedSequenceValue = url.searchParams.get("sequence");
        const requestedSequence = requestedSequenceValue === null
          ? null
          : Number(requestedSequenceValue);
        const hasRequestedSequence = requestedSequence !== null &&
          Number.isInteger(requestedSequence);
        const selectedStoredFrame = hasRequestedSequence
          ? storedFrameForSequence(requestedSequence)
          : currentFrame ?? undefined;
        const selectedFrame = selectedStoredFrame?.frame;
        const selectedSequence = hasRequestedSequence
          ? requestedSequence
          : currentFrame?.sequence;
        if (
          !selectedFrame ||
          selectedFrame.deviceId !== deviceId ||
          (cameraOnly && selectedFrame.role !== "verification") ||
          !selectedSequence ||
          Math.max(0, Date.now() - selectedFrame.capturedAt) >
            (hasRequestedSequence ? ACTION_FRAME_MAX_AGE_MS : FRAME_FRESHNESS_MS)
        ) {
          throw new PhonebaseApiError(
            "A fresh camera frame is not available.",
            503,
            "FRAME_UNAVAILABLE",
          );
        }
        if (!selectedStoredFrame) throw new Error("The stored frame format is invalid.");
        retainActionFrame(selectedStoredFrame);
        setHeaders(request, response, 200, selectedStoredFrame.mimeType);
        response.setHeader("Content-Length", String(selectedStoredFrame.bytes.length));
        response.setHeader("X-Phonebase-Frame-Sequence", String(selectedSequence));
        response.setHeader("X-Phonebase-Frame-Width", String(selectedFrame.width));
        response.setHeader("X-Phonebase-Frame-Height", String(selectedFrame.height));
        response.setHeader("X-Phonebase-Captured-At", String(selectedFrame.capturedAt));
        response.end(selectedStoredFrame.bytes);
        return;
      }

      if (request.method === "POST" && resource === "actions") {
        const action = parsePhonebaseActionEnvelope(await readJson<unknown>(request));
        const context = actionRequestContext(request);
        observability.record({kind:"action.requested", ...context, deviceId, actionType:action.action.type,
          details:{action:actionDetails(action.action)}});
        const result = await executeSemanticAction(
          deviceId,
          action,
          context,
        );
        if (context.source === "dashboard" && !("replayed" in result)) {
          await recorder.record(deviceId, action.action, result.receipt?.id ?? "");
        }
        sendJson(request, response, {
          ok: true,
          protocolVersion: PHONEBASE_PROTOCOL_VERSION,
          idempotencyKey: action.idempotencyKey,
          result,
        }, result.status === "accepted" ? 202 : 200);
        return;
      }

      if (request.method === "POST" && resource === "visual-actions") {
        const visualAction = parsePhonebaseVisualActionEnvelope(
          await readJson<unknown>(request),
        );
        const context = actionRequestContext(request);
        observability.record({
          kind: "visual_action.requested",
          ...context,
          deviceId,
          actionType: visualAction.action.type,
          details: {
            type: visualAction.action.type,
            target: visualAction.action.type === "open_app"
              ? visualAction.action.appName
              : visualAction.action.target,
          },
        });
        const result = await executeVisualAction(deviceId, visualAction, context);
        sendJson(request, response, {
          ok: true,
          protocolVersion: PHONEBASE_PROTOCOL_VERSION,
          idempotencyKey: visualAction.idempotencyKey,
          result,
        }, result.status === "accepted" ? 202 : 200);
        return;
      }

      if (request.method === "GET" && resource === "actions") {
        const receipts = [...actionReceipts.values()]
          .filter((receipt) => receipt.deviceId === deviceId)
          .sort((left, right) => right.createdAt - left.createdAt)
          .map(publicActionReceipt);
        sendJson(request, response, {
          ok: true,
          protocolVersion: PHONEBASE_PROTOCOL_VERSION,
          receipts,
        });
        return;
      }

      if (request.method === "GET" && resource === "calibration") {
        sendJson(request, response, {
          ok: true,
          calibration: calibrationState(deviceId),
        });
        return;
      }

      if (request.method === "POST" && resource === "calibration") {
        const calibration = await updateCalibration(
          deviceId,
          await readJson<unknown>(request),
        );
        sendJson(request, response, { ok: true, calibration });
        return;
      }
    }

    if (request.method === "GET" && url.pathname === "/api/frame") {
      const raw = url.searchParams.get("raw") === "1";
      const requestedDeviceId = url.searchParams.get("deviceId") ?? "";
      const requestedRuntime = requestedDeviceId
        ? existingDeviceFrameRuntime(requestedDeviceId)
        : null;
      const requestedSequenceValue = url.searchParams.get("sequence");
      const requestedSequence = requestedSequenceValue === null
        ? null
        : Number(requestedSequenceValue);
      const hasRequestedSequence = requestedSequence !== null &&
        Number.isInteger(requestedSequence);
      const selectedStoredFrame = hasRequestedSequence
        ? storedFrameForSequence(requestedSequence)
        : raw
          ? requestedRuntime?.latestVerificationFrame ?? latestVerificationFrame ?? undefined
          : requestedRuntime?.latestFrame ?? latestFrame ?? undefined;
      if (!selectedStoredFrame) {
        sendJson(request, response, { ok: false, error: "No frame is available yet." }, 404);
        return;
      }
      retainActionFrame(selectedStoredFrame);
      setHeaders(request, response, 200, selectedStoredFrame.mimeType);
      response.setHeader("Content-Length", String(selectedStoredFrame.bytes.length));
      response.setHeader(
        "X-Phonebase-Frame-Sequence",
        String(selectedStoredFrame.sequence),
      );
      response.setHeader(
        "X-Phonebase-Captured-At",
        String(selectedStoredFrame.frame.capturedAt),
      );
      response.end(selectedStoredFrame.bytes);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/frame") {
      const frame = validateFrame(await readJson<Partial<ScreenFrame>>(request));
      const match = frame.dataUrl.match(
        /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/,
      );
      if (!match) throw new Error("The stored frame format is invalid.");
      const stored = storeFrame(
        frame,
        match[1] as StoredFrame["mimeType"],
        Buffer.from(match[2], "base64"),
      );
      sendJson(request, response, {
        ok: true,
        frame: publicFrame(stored),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/frame/jpeg") {
      const bytes = await readBytes(request);
      if (!bytes.length) throw new Error("The JPEG frame cannot be empty.");
      const width = Number(request.headers["x-phonebase-frame-width"]);
      const height = Number(request.headers["x-phonebase-frame-height"]);
      const capturedAt = Number(request.headers["x-phonebase-captured-at"]);
      const deviceId = String(
        request.headers["x-phonebase-device-id"] ?? "",
      );
      const source = String(
        request.headers["x-phonebase-frame-source"] ?? "hardware-camera-node",
      );
      const role = String(
        request.headers["x-phonebase-frame-role"] ?? "control",
      ) === "verification" ? "verification" : "control";
      const frame = validateFrame({
        dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
        width,
        height,
        capturedAt,
        source,
        deviceId,
        role,
      });
      const stored = storeFrame(frame, "image/jpeg", bytes);
      sendJson(request, response, {
        ok: true,
        frame: publicFrame(stored),
      });
      return;
    }

    const nodeCommandMatch = url.pathname.match(
      /^\/api\/nodes\/([^/]+)\/commands$/,
    );
    if (request.method === "POST" && nodeCommandMatch) {
      const deviceId = decodeURIComponent(nodeCommandMatch[1]);
      const node = requireOnlineNode(deviceId);
      const command = validateNodeCommand(
        await readJson<Partial<NodeCommand>>(request),
      );
      if (publishing.busy(deviceId)) {
        if (command.action !== "hold") throw new PhonebaseApiError("手机正在执行发送计划，请先暂停。", 409, "DEVICE_BUSY");
        publishing.stopDevice(deviceId);
      }
      const envelope = sendNodeEnvelope(node, {
        id: `node-${Date.now().toString(36)}`,
        ...command,
      });
      sendJson(request, response, { ok: true, command: envelope }, 202);
      return;
    }

    sendJson(request, response, { ok: false, error: "Not found" }, 404);
  } catch (error) {
    const message = errorMessage(error);
    const status = error instanceof PhonebaseApiError || error instanceof ManualCalibrationError
      ? error.status
      : /previous command/i.test(message)
        ? 409
        : 400;
    const code = error instanceof PhonebaseApiError || error instanceof ManualCalibrationError
      ? error.code
      : error instanceof PhonebaseActionValidationError ||
          error instanceof PhonebaseVisualActionValidationError
        ? error.code
        : "BAD_REQUEST";
    sendJson(request, response, { ok: false, error: message, code }, status);
  }
});

const nodeSocketServer = new WebSocketServer({ noServer: true });
const liveSocketServer = new WebSocketServer({ noServer: true });

liveSocketServer.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const deviceId = String(url.searchParams.get("deviceId") ?? "")
    .trim()
    .slice(0, 120);
  const raw = url.searchParams.get("raw") === "1";
  const subscriber = { socket, deviceId, raw };
  liveSubscribers.add(subscriber);
  const runtime = deviceId ? existingDeviceFrameRuntime(deviceId) : null;
  const initialFrame = raw
    ? runtime?.latestVerificationFrame ?? latestVerificationFrame
    : runtime?.latestFrame ?? latestFrame;
  if (
    initialFrame &&
    (!deviceId || initialFrame.frame.deviceId === deviceId)
  ) {
    sendLiveFrame(socket, initialFrame, raw);
  }
  socket.on("close", () => liveSubscribers.delete(subscriber));
  socket.on("error", () => liveSubscribers.delete(subscriber));
});

nodeSocketServer.on("connection", (socket) => {
  let boundDeviceId = "";

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        deviceId?: string;
        name?: string;
        state?: unknown;
        payload?: unknown;
      };
      const deviceId = String(message.deviceId ?? "").trim().slice(0, 120);
      if (!deviceId) {
        socket.close(1008, "deviceId required");
        return;
      }

      boundDeviceId = deviceId;
      const existing = remoteNodes.get(deviceId);
      const now = Date.now();
      const node: RemoteNode = {
        deviceId,
        socket,
        connectedAt:
          existing?.socket === socket ? existing.connectedAt : now,
        lastSeenAt: now,
        lastStateAt: message.state !== undefined ? now : existing?.socket === socket ? existing.lastStateAt : 0,
        state: message.state ?? existing?.state ?? null,
        lastEvent:
          message.type === "event"
            ? message.payload ?? null
            : existing?.lastEvent ?? null,
      };
      remoteNodes.set(deviceId, node);
      if (message.state !== undefined) {
        reconcileOperationState(deviceId, message.state);
      }
      if (message.type === "event" && message.name === "command-result") {
        reconcileCommandResult(deviceId, message.payload);
      }
      if (message.type === "heartbeat" && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: "heartbeat_ack",
          deviceId,
          at: now,
        }));
      }
    } catch {
      socket.close(1007, "invalid JSON");
    }
  });

  socket.on("close", () => {
    if (!boundDeviceId) return;
    const current = remoteNodes.get(boundDeviceId);
    if (current?.socket === socket) {
      remoteNodes.delete(boundDeviceId);
      failOpenReceipts(
        boundDeviceId,
        "The Phonebase node disconnected before final confirmation; its local safety gate has been locked.",
      );
    }
  });
});

server.on("upgrade", (request, socket, head) => {
  if (!requestIsAuthorized(request)) {
    socket.destroy();
    return;
  }
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (url.pathname === "/api/node/socket") {
    nodeSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      nodeSocketServer.emit("connection", webSocket, request);
    });
    return;
  }
  if (url.pathname === "/api/live/socket") {
    liveSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      liveSocketServer.emit("connection", webSocket, request);
    });
    return;
  }
  socket.destroy();
});

const unhealthySince = new Map<string, number>();
const knownDevices = new Set<string>();
const healthMonitor = setInterval(() => {
  for (const id of phonebaseDeviceIds()) knownDevices.add(id);
  for (const deviceId of knownDevices) {
    const node=remoteNodes.get(deviceId); const state=objectValue(node?.state); const grbl=objectValue(state.grbl);
    const runtime=existingDeviceFrameRuntime(deviceId);
    const checks: Array<[string,boolean,string]> = [
      ["node", !node || Date.now()-node.lastSeenAt>5000, "Device connection lost"],
      ["mirror", state.digitalConnected===false || (Boolean(runtime?.latestControlFrame) && !frameIsFresh(runtime?.latestControlFrame ?? null)), "HD mirror unavailable"],
      ["camera", state.cameraReady===false, "Physical camera unavailable"],
      ["controller", /alarm|error/i.test(String(grbl.state)), "Controller requires attention"],
      ["alignment", runtime?.frameSyncState.status==="mismatch", "Camera / mirror mismatch — inspect alignment"],
    ];
    for (const [name,bad,title] of checks) {
      const key=`health:${deviceId}:${name}`;
      if(bad && !unhealthySince.has(key)) unhealthySince.set(key,Date.now());
      if(!bad) unhealthySince.delete(key);
      if(!bad || Date.now()-(unhealthySince.get(key)??Date.now())>=5000)
        observability.flag(key,bad,title,deviceId,{cameraReady:state.cameraReady,digitalReady:state.digitalReady,controller:grbl.state,alignment:runtime?.frameSyncState});
    }
  }
},2000);
healthMonitor.unref();
server.listen(PORT, HOST, () => {
  console.log(`Phonebase control plane listening on http://${HOST}:${PORT}`);
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;

  console.log(`Received ${signal}; closing Phonebase node connections`);
  for (const client of nodeSocketServer.clients) {
    try {
      client.close(1012, "service restart");
    } catch {
      client.terminate();
    }
  }
  for (const client of liveSocketServer.clients) {
    try {
      client.close(1012, "service restart");
    } catch {
      client.terminate();
    }
  }

  nodeSocketServer.close();
  liveSocketServer.close();
  server.close(() => {
    Promise.allSettled([
      receiptWriteQueue,
      auditWriteQueue,
      observability.flush(),
      recorder.flush(),
    ])
      .finally(() => process.exit(0));
  });

  const forceExitTimer = setTimeout(() => {
    for (const client of nodeSocketServer.clients) {
      client.terminate();
    }
    for (const client of liveSocketServer.clients) {
      client.terminate();
    }
    process.exit(0);
  }, 1_500);
  forceExitTimer.unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(signal));
}
