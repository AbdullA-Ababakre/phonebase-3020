#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  fromJsonSchema,
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  PHONEBASE_MAX_TEXT_LENGTH,
  PHONEBASE_TAP_MAX_DURATION_MS,
  PHONEBASE_TAP_MIN_DURATION_MS,
} from "../agent/action-contract";

type JsonObject = Record<string, unknown>;

type McpTool = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};

type ScreenshotObservation = {
  bytes: Buffer;
  mimeType: string;
  metadata: {
    frameSequence: number;
    capturedAt: number;
    frameWidth: number;
    frameHeight: number;
  };
};

const API_BASE = new URL(
  process.env.PHONEBASE_API_URL ?? "http://127.0.0.1:3013",
);
const API_TOKEN = process.env.PHONEBASE_API_TOKEN?.trim() ?? "";
const ACTION_TIMEOUT_MS = Math.min(
  300_000,
  Math.max(5_000, Number(process.env.PHONEBASE_MCP_ACTION_TIMEOUT_MS ?? 120_000)),
);
const HOME_ENABLED = process.env.PHONEBASE_MCP_ALLOW_HOME === "1";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MCP_INSTRUCTIONS = "List devices and read capabilities first. Prefer phonebase_open_app and phonebase_tap_text when the target has a visible label; they run OCR at the station and avoid a slow screenshot-to-coordinate round trip. When the standard iOS English keyboard is visible, send the whole value with one phonebase_input_text call; never tap keyboard letters one at a time. For coordinate actions, read a fresh screenshot and use its exact frameSequence and viewport. Action tools wait for the final hardware receipt. Never bypass a safety gate or claim the workspace is clear without a human check.";
const MCP_PROTOCOL_VERSIONS = ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS];
const UI_VERIFICATION_INSTRUCTIONS = " A completed hardware receipt is NOT UI success. Supply expectedScreen on each UI action or call phonebase_wait_for_screen afterward. Verify exact typed text inside the actual field bounds, not suggestions/history. Wait for keyboard and content readiness separately. On not_matched or unknown, inspect the returned screenshot and preserve the receipt; never blindly resend motion. Recognize account/onboarding/install gates as blockers. App opening can restore a stale launch preview before becoming ready. Unlabeled visible Home icons use a qualified station visual fallback when configured.";

if (!["http:", "https:"].includes(API_BASE.protocol)) {
  throw new Error("PHONEBASE_API_URL must use http or https");
}
if (
  !LOCAL_HOSTS.has(API_BASE.hostname) &&
  process.env.PHONEBASE_MCP_ALLOW_REMOTE !== "1"
) {
  throw new Error(
    "Remote Phonebase MCP connections require PHONEBASE_MCP_ALLOW_REMOTE=1",
  );
}

if (!LOCAL_HOSTS.has(API_BASE.hostname) && (API_BASE.protocol !== "https:" || !API_TOKEN)) {
  throw new Error("Remote Phonebase MCP requires HTTPS and PHONEBASE_API_TOKEN");
}
if (API_BASE.username || API_BASE.password || API_BASE.search || API_BASE.hash) {
  throw new Error("PHONEBASE_API_URL must not contain credentials, query parameters, or a fragment");
}

const deviceProperty = {
  deviceId: {
    type: "string",
    minLength: 1,
    maxLength: 120,
    description: "Exact deviceId returned by phonebase_list_devices",
  },
};
const screenExpectationProperties = {
  text: {type:"string",minLength:1,maxLength:120},
  match: {type:"string",enum:["exact","contains"]},
  region: {type:"string",enum:["all","top","input"]},
  keyboard: {type:"boolean"},
  timeoutMs: {type:"integer",minimum:0,maximum:10000},
  afterSequence: {type:"integer",minimum:0},
  bounds:{type:"object",properties:Object.fromEntries(["left","top","right","bottom"].map(k=>[k,{type:"number",minimum:0,maximum:1}])),required:["left","top","right","bottom"],additionalProperties:false},
};
const pointSchema = {
  type: "object",
  properties: {
    x: { type: "number" },
    y: { type: "number" },
  },
  required: ["x", "y"],
  additionalProperties: false,
};
const viewportSchema = {
  type: "object",
  properties: {
    width: { type: "number", minimum: 64, maximum: 8192 },
    height: { type: "number", minimum: 64, maximum: 8192 },
  },
  required: ["width", "height"],
  additionalProperties: false,
};
const touchContextProperties = {
  viewport: viewportSchema,
  frameSequence: {
    type: "integer",
    minimum: 1,
    description: "Exact recent frame sequence used to choose the coordinates",
  },
  touchZ: {
    type: "number",
    description: "Optional depth within this device's verified touch range",
  },
};

const TOOLS: McpTool[] = [
  {
    name:"phonebase_wait_for_screen",
    description:"Read-only bounded screen postcondition check, using literal OCR on two fresh synchronized frames. Exact input checks preserve punctuation. Does not retry any physical action. Returns evidence image; matched text is not proof of a whole workflow.",
    inputSchema:{type:"object",properties:{...deviceProperty,...screenExpectationProperties},required:["deviceId"],anyOf:[{required:["text"]},{required:["keyboard"]}],additionalProperties:false},
  },
  {
    name: "phonebase_list_devices",
    description: "List physical devices, live state, frames, and per-action capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "phonebase_get_device",
    description: "Read one physical device and the reasons any capability is unavailable.",
    inputSchema: {
      type: "object",
      properties: deviceProperty,
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_get_screenshot",
    description: "Return the latest or an exact recent physical-device frame as MCP image content.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        sequence: { type: "integer", minimum: 1 },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_observe",
    description: "Return one device's live safety state together with its latest physical screenshot and exact frame metadata.",
    inputSchema: {
      type: "object",
      properties: deviceProperty,
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_tap_text",
    description: "Find a unique visible text label with station-side OCR, tap it immediately from the same fresh frame, and wait for the final receipt.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        target: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["deviceId", "target"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_open_app",
    description: "Open an iPhone app in one call: return to the Home Screen when needed, locate the app label with station-side OCR, tap its icon from the same fresh frame, and wait for the final receipt.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        appName: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["deviceId", "appName"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_hover_move",
    description: "Move the arm above a frame-derived screen point without touching it.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        point: pointSchema,
        viewport: touchContextProperties.viewport,
        frameSequence: touchContextProperties.frameSequence,
      },
      required: ["deviceId", "point", "viewport", "frameSequence"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_tap",
    description: "Tap a point from an exact recent device frame and wait for the final hardware receipt.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        point: pointSchema,
        ...touchContextProperties,
        durationMs: {
          type: "integer",
          minimum: PHONEBASE_TAP_MIN_DURATION_MS,
          maximum: PHONEBASE_TAP_MAX_DURATION_MS,
          description: "Verified mechanical dwell for a normal tap; use phonebase_long_press for longer contact.",
        },
      },
      required: ["deviceId", "point", "viewport", "frameSequence"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_long_press",
    description: "Long-press a frame-derived point and wait for the final hardware receipt.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        point: pointSchema,
        ...touchContextProperties,
        durationMs: { type: "integer", minimum: 500, maximum: 5000 },
      },
      required: ["deviceId", "point", "viewport", "frameSequence", "durationMs"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_swipe",
    description: "Swipe between two frame-derived points and wait for the final hardware receipt.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        start: pointSchema,
        end: pointSchema,
        ...touchContextProperties,
        durationMs: { type: "integer", minimum: 250, maximum: 3000 },
      },
      required: ["deviceId", "start", "end", "viewport", "frameSequence", "durationMs"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_input_text",
    description: "Type a complete text value in one call. The station verifies that the standard iOS English keyboard is visible, maps the full string through the calibrated screen, and executes the physical tap sequence locally. Prefer this over tapping individual keyboard letters.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        text: { type: "string", minLength: 1, maxLength: PHONEBASE_MAX_TEXT_LENGTH },
        touchZ: touchContextProperties.touchZ,
      },
      required: ["deviceId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_phone_key",
    description: "Send a supported Back, Enter, or phone Home control.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        key: { type: "string", enum: ["back", "enter", "home"] },
        touchZ: touchContextProperties.touchZ,
      },
      required: ["deviceId", "key"],
      additionalProperties: false,
    },
  },
  ...["status", "hold", "resume"].map((action) => ({
    name: `phonebase_${action}`,
    description: action === "hold"
      ? "Immediately place the device controller in Hold."
      : action === "resume"
        ? "Release a safe controller Hold without bypassing calibration gates."
        : "Request a fresh controller status update.",
    inputSchema: {
      type: "object",
      properties: deviceProperty,
      required: ["deviceId"],
      additionalProperties: false,
    },
  })),
  {
    name: "phonebase_home",
    description: "Run homing only after a human clears the workspace and an administrator enables PHONEBASE_MCP_ALLOW_HOME=1.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        workspaceClear: {
          type: "boolean",
          const: true,
          description: "Must be true after a human clears hands, cables, and tools",
        },
      },
      required: ["deviceId", "workspaceClear"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_wait",
    description: "Wait for a bounded duration as a deterministic physical workflow step.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        durationMs: { type: "integer", minimum: 0, maximum: 5000 },
      },
      required: ["deviceId", "durationMs"],
      additionalProperties: false,
    },
  },
  {
    name: "phonebase_get_receipt",
    description: "Read accepted, executing, completed, or failed state for a physical action.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        receiptId: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["deviceId", "receiptId"],
      additionalProperties: false,
    },
  },
];

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function requiredString(input: JsonObject, key: string) {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function requiredText(input: JsonObject) {
  const value = input.text;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("text is required");
  }
  if (value.length > PHONEBASE_MAX_TEXT_LENGTH) {
    throw new Error(`text exceeds ${PHONEBASE_MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

function optionalNumber(input: JsonObject, key: string) {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function headers(extra: Record<string, string> = {}) {
  return {
    Accept: "application/json",
    "X-Phonebase-Actor": "mcp",
    "X-Phonebase-Client": "mcp",
    "X-Request-Id": `mcp-${randomUUID()}`,
    ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    ...extra,
  };
}

class PhonebaseToolError extends Error {
  constructor(message: string, readonly code: string, readonly httpStatus?: number) {
    super(message);
  }
}

async function apiJson(path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, `${API_BASE.origin}/`), {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30_000),
    redirect: "error",
    headers: headers(init.headers as Record<string, string> | undefined),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) as unknown : null;
  } catch {
    if (response.ok) {
      throw new PhonebaseToolError("PhoneUse returned an invalid API response. The action outcome is unknown; retain the same idempotency key when checking or retrying.", "INVALID_API_RESPONSE", response.status);
    }
    // Reverse proxies may return an HTML error page. Preserve the real HTTP
    // status instead of exposing a JSON parser error (or arbitrary HTML).
  }
  if (!response.ok) {
    const detail = objectValue(payload);
    throw new PhonebaseToolError(String(detail.error ?? `Phonebase API returned ${response.status}`), String(detail.code ?? `HTTP_${response.status}`), response.status);
  }
  return payload;
}

async function readScreenshot(deviceId: string, sequence?: number): Promise<ScreenshotObservation> {
  const query = sequence === undefined ? "" : `?sequence=${Math.round(sequence)}`;
  const response = await fetch(
    new URL(`/api/v1/devices/${encodeURIComponent(deviceId)}/screenshot${query}`, `${API_BASE.origin}/`),
    { headers: headers(), signal: AbortSignal.timeout(15_000), redirect: "error" },
  );
  if (!response.ok) {
    const detail = objectValue(await response.json().catch(() => ({})));
    throw new PhonebaseToolError(String(detail.error ?? `Screenshot returned ${response.status}`), String(detail.code ?? `HTTP_${response.status}`), response.status);
  }
  const metadata = {} as ScreenshotObservation["metadata"];
  for (const [field, header] of Object.entries({
    frameSequence: "x-phonebase-frame-sequence", capturedAt: "x-phonebase-captured-at",
    frameWidth: "x-phonebase-frame-width", frameHeight: "x-phonebase-frame-height",
  }) as [keyof ScreenshotObservation["metadata"], string][]) {
    const raw = response.headers.get(header);
    const value = Number(raw);
    if (!raw || !Number.isSafeInteger(value) || value <= 0) {
      throw new PhonebaseToolError(`Screenshot is missing valid ${header}; obtain a new frame after the station is repaired.`, "INVALID_FRAME_METADATA");
    }
    metadata[field] = value;
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg",
    metadata,
  };
}

function screenshotResult(deviceId: string, screenshot: ScreenshotObservation, extra: JsonObject = {}): CallToolResult {
  const observation = {
    deviceId,
    ...screenshot.metadata,
    frameAgeMs: Math.max(0, Date.now() - screenshot.metadata.capturedAt),
    coordinateSpace: "returned screenshot pixels",
    nextStep: "Use this exact frameSequence and frame size for tap, long press, swipe, or hover move.",
    ...extra,
  };
  return {
    structuredContent: observation,
    content: [
      {
        type: "image" as const,
        data: screenshot.bytes.toString("base64"),
        mimeType: screenshot.mimeType,
      },
      { type: "text" as const, text: JSON.stringify(observation, null, 2) },
    ],
  };
}

async function submitRequest(deviceId: string, path: string, body: JsonObject) {
  const submitted = objectValue(await apiJson(
    `/api/v1/devices/${encodeURIComponent(deviceId)}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  const submittedResult = objectValue(submitted.result);
  let receipt = objectValue(submittedResult.receipt);
  const receiptId = typeof receipt.id === "string" ? receipt.id : "";
  if (!receiptId) {
    throw new PhonebaseToolError("The API did not return an action receipt; completion is unknown. Do not repeat the action with a new idempotency key.", "MISSING_ACTION_RECEIPT");
  }
  if (["completed", "failed"].includes(String(receipt.status))) {
    return {
      ...submitted,
      result: { ...submittedResult, status: receipt.status, receipt },
      mcp: { waitedForFinalReceipt: true, timedOut: false },
    };
  }

  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  let pollDelayMs = 150;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollDelayMs));
    const receiptPayload = objectValue(await apiJson(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/actions/${encodeURIComponent(receiptId)}`,
    ));
    receipt = objectValue(receiptPayload.receipt);
    if (["completed", "failed"].includes(String(receipt.status))) {
      return {
        ...submitted,
        result: { ...submittedResult, status: receipt.status, receipt },
        mcp: { waitedForFinalReceipt: true, timedOut: false },
      };
    }
    pollDelayMs = Math.min(1_000, Math.round(pollDelayMs * 1.5));
  }
  return {
    ...submitted,
    result: { ...submittedResult, status: receipt.status, receipt },
    mcp: {
      waitedForFinalReceipt: true,
      timedOut: true,
      nextTool: "phonebase_get_receipt",
    },
  };
}

async function submitAction(deviceId: string, action: JsonObject, idempotencyKey: string) {
  return submitRequest(deviceId, "actions", { idempotencyKey, action });
}

async function submitVisualAction(
  deviceId: string,
  action: JsonObject,
  idempotencyKey: string,
) {
  return submitRequest(deviceId, "visual-actions", { idempotencyKey, action });
}

function textResult(value: unknown): CallToolResult {
  const envelope = objectValue(value);
  const result = objectValue(envelope.result);
  if (objectValue(result.receipt).id) envelope.execution = {
    physicalStatus:objectValue(result.receipt).status,
    uiStatus:objectValue(result.receipt).uiVerification ?? "not_verified",
    nextStep:"Hardware completion alone is not UI success. Use expectedScreen or phonebase_wait_for_screen; inspect its evidence before continuing. Never blindly replay an uncertain action.",
  };
  const failed = objectValue(result.receipt).status === "failed"
    || objectValue(envelope.receipt).status === "failed"
    || objectValue(envelope.mcp).timedOut === true;
  return {
    ...(failed ? { isError: true } : {}),
    ...(Object.keys(envelope).length ? { structuredContent: envelope } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function verifyScreen(deviceId: string, expectation: JsonObject, afterCapturedAt?: number) {
  const params = new URLSearchParams();
  for (const key of Object.keys(screenExpectationProperties)) {
    if (expectation[key] !== undefined) params.set(key,key === "bounds" ? JSON.stringify(expectation[key]) : String(expectation[key]));
  }
  if (!params.has("timeoutMs")) params.set("timeoutMs","3000");
  if (afterCapturedAt) params.set("afterCapturedAt",String(afterCapturedAt));
  return objectValue(await apiJson(`/api/v1/devices/${encodeURIComponent(deviceId)}/screen-state?${params}`));
}

async function withScreenVerification(deviceId: string, expectation: JsonObject, result?: CallToolResult): Promise<CallToolResult> {
  let checked: JsonObject;
  const receipt = objectValue(objectValue(result?.structuredContent).result);
  const completedAt = objectValue(receipt.receipt).completedAt;
  try { checked = await verifyScreen(deviceId,expectation,typeof completedAt === "number" ? completedAt : undefined); }
  catch (error) {
    // Preserve the original receipt on a read failure: never invite a blind replay.
    const payload = {...objectValue(result?.structuredContent),uiVerification:{status:"unknown",error:error instanceof Error ? error.message : "Screen verification unavailable",physicalActionRetried:false}};
    return {...textResult(payload),isError:true};
  }
  const verification = objectValue(checked.verification);
  const payload = {...objectValue(result?.structuredContent),...(!result ? checked : {}),uiVerification:verification};
  const output = textResult(payload);
  if (verification.matched !== true) output.isError = true;
  if (typeof verification.frameSequence === "number") {
    try {
      const shot = screenshotResult(deviceId,await readScreenshot(deviceId,verification.frameSequence));
      output.content.push(...shot.content.filter(item=>item.type === "image"));
    } catch { /* OCR metadata and original receipt remain available. */ }
  }
  return output;
}

async function callTool(name: string, rawArguments: unknown): Promise<CallToolResult> {
  const input = objectValue(rawArguments);
  const deviceId = name === "phonebase_list_devices"
    ? ""
    : requiredString(input, "deviceId");

  if (name === "phonebase_list_devices") {
    return textResult(await apiJson("/api/v1/devices"));
  }
  if (name === "phonebase_get_device") {
    return textResult(await apiJson(`/api/v1/devices/${encodeURIComponent(deviceId)}`));
  }
  if (name === "phonebase_wait_for_screen") return withScreenVerification(deviceId,input);
  if (name === "phonebase_get_receipt") {
    const receiptId = requiredString(input, "receiptId");
    return textResult(await apiJson(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/actions/${encodeURIComponent(receiptId)}`,
    ));
  }
  if (name === "phonebase_get_screenshot") {
    const sequence = optionalNumber(input, "sequence");
    return screenshotResult(deviceId, await readScreenshot(deviceId, sequence));
  }
  if (name === "phonebase_observe") {
    const [devicePayload, screenshot] = await Promise.all([
      apiJson(`/api/v1/devices/${encodeURIComponent(deviceId)}`),
      readScreenshot(deviceId),
    ]);
    return screenshotResult(deviceId, screenshot, {
      observedAt: Date.now(),
      device: objectValue(devicePayload).device ?? devicePayload,
    });
  }
  if (name === "phonebase_tap_text") {
    return textResult(await submitVisualAction(deviceId, {
      type: "tap_text",
      target: requiredString(input, "target"),
    }, requiredString(input, "idempotencyKey")));
  }
  if (name === "phonebase_open_app") {
    return textResult(await submitVisualAction(deviceId, {
      type: "open_app",
      appName: requiredString(input, "appName"),
    }, requiredString(input, "idempotencyKey")));
  }

  const touchContext = {
    viewport: objectValue(input.viewport),
    frameSequence: optionalNumber(input, "frameSequence"),
    ...(optionalNumber(input, "touchZ") === undefined
      ? {}
      : { touchZ: optionalNumber(input, "touchZ") }),
  };
  let action: JsonObject;
  switch (name) {
    case "phonebase_hover_move":
      action = {
        type: name.replace("phonebase_", ""),
        point: objectValue(input.point),
        viewport: touchContext.viewport,
        frameSequence: touchContext.frameSequence,
      };
      break;
    case "phonebase_tap":
      action = {
        type: "tap",
        point: objectValue(input.point),
        ...(optionalNumber(input, "durationMs") === undefined
          ? {}
          : { durationMs: optionalNumber(input, "durationMs") }),
        ...touchContext,
      };
      break;
    case "phonebase_long_press":
      action = {
        type: "long_press",
        point: objectValue(input.point),
        durationMs: optionalNumber(input, "durationMs"),
        ...touchContext,
      };
      break;
    case "phonebase_swipe":
      action = {
        type: "swipe",
        start: objectValue(input.start),
        end: objectValue(input.end),
        durationMs: optionalNumber(input, "durationMs"),
        ...touchContext,
      };
      break;
    case "phonebase_input_text":
      action = {
        type: "input_text",
        text: requiredText(input),
        ...(optionalNumber(input, "touchZ") === undefined
          ? {}
          : { touchZ: optionalNumber(input, "touchZ") }),
      };
      break;
    case "phonebase_phone_key":
      action = {
        type: "phone_key",
        key: requiredString(input, "key"),
        ...(optionalNumber(input, "touchZ") === undefined
          ? {}
          : { touchZ: optionalNumber(input, "touchZ") }),
      };
      break;
    case "phonebase_home":
      if (!HOME_ENABLED) {
        throw new Error(
          "Homing through MCP is disabled. A human must clear the workspace and an administrator must set PHONEBASE_MCP_ALLOW_HOME=1.",
        );
      }
      if (input.workspaceClear !== true) {
        throw new Error("workspaceClear must be true before machine homing");
      }
      action = { type: "home", confirmation: "CLEAR_WORKSPACE_AND_HOME" };
      break;
    case "phonebase_wait":
      action = { type: "wait", durationMs: optionalNumber(input, "durationMs") };
      break;
    case "phonebase_status":
    case "phonebase_hold":
    case "phonebase_resume":
      action = { type: name.replace("phonebase_", "") };
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  const idempotencyKey = name === "phonebase_status"
    ? `mcp-status-${randomUUID()}`
    : requiredString(input, "idempotencyKey");
  return textResult(await submitAction(deviceId, action, idempotencyKey));
}

function buildServer() {
  const server = new McpServer(
    { name: "phonebase", version: "0.7.0" },
    {
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS + UI_VERIFICATION_INSTRUCTIONS,
      supportedProtocolVersions: MCP_PROTOCOL_VERSIONS,
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "public" },
        "server/discover": { ttlMs: 300_000, cacheScope: "public" },
      },
    },
  );
  const readOnlyTools = new Set([
    "phonebase_list_devices",
    "phonebase_get_device",
    "phonebase_get_screenshot",
    "phonebase_observe",
    "phonebase_wait_for_screen",
    "phonebase_status",
    "phonebase_get_receipt",
  ]);

  for (const tool of TOOLS) {
    if (tool.name === "phonebase_home" && (!HOME_ENABLED || !LOCAL_HOSTS.has(API_BASE.hostname))) continue;
    if (!readOnlyTools.has(tool.name)) {
      const properties = objectValue(tool.inputSchema.properties);
      tool.inputSchema.properties = { ...properties, idempotencyKey: {
        type: "string", minLength: 1, maxLength: 160,
        description: "Stable workflow step ID. Reuse with identical arguments after an uncertain response; never retry with a new key until the outcome is known.",
      }, expectedScreen: {
        type:"object",properties:screenExpectationProperties,additionalProperties:false,
        description:"Optional visible postcondition checked after the final receipt. Use exact+input for full field values, keyboard:true for focus. Failure preserves the receipt and never replays motion.",
      } };
      const required = Array.isArray(tool.inputSchema.required)
        ? tool.inputSchema.required.filter((value): value is string => typeof value === "string")
        : [];
      tool.inputSchema.required = [...new Set([...required, "idempotencyKey"])];
    }
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<JsonObject>(tool.inputSchema as JsonSchemaType),
        annotations: {
          readOnlyHint: readOnlyTools.has(tool.name),
          destructiveHint: !readOnlyTools.has(tool.name),
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input) => {
        try {
          const result = await callTool(tool.name, input);
          if (!result.isError && !readOnlyTools.has(tool.name) && input.expectedScreen) {
            return await withScreenVerification(requiredString(input,"deviceId"),objectValue(input.expectedScreen),result);
          }
          return result;
        } catch (error) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : "Phonebase tool failed",
                code: error instanceof PhonebaseToolError ? error.code : "MCP_TOOL_ERROR",
                ...(error instanceof PhonebaseToolError && error.httpStatus ? { httpStatus: error.httpStatus } : {}),
              }),
            }],
          };
        }
      },
    );
  }

  return server;
}

serveStdio(buildServer, {
  legacy: "serve",
  onerror(error) {
    process.stderr.write(`Phonebase MCP: ${error.message}\n`);
  },
});
