export const PHONEBASE_ACTION_TYPES = [
  "status",
  "hold",
  "resume",
  "home",
  "hover_move",
  "tap",
  "long_press",
  "swipe",
  "input_text",
  "phone_key",
  "wait",
] as const;

export type PhonebaseActionType = (typeof PHONEBASE_ACTION_TYPES)[number];

export const PHONEBASE_MAX_TEXT_LENGTH = 120;
export const PHONEBASE_TAP_MIN_DURATION_MS = 30;
export const PHONEBASE_TAP_MAX_DURATION_MS = 40;
export const PHONEBASE_TAP_DEFAULT_DURATION_MS = 40;

export type PhonebaseViewport = {
  width: number;
  height: number;
};

export type PhonebasePoint = {
  x: number;
  y: number;
};

export type PhonebaseSemanticAction =
  | { type: "status" }
  | { type: "hold" }
  | { type: "resume" }
  | { type: "home"; confirmation: "CLEAR_WORKSPACE_AND_HOME" }
  | {
      type: "hover_move";
      point: PhonebasePoint;
      viewport: PhonebaseViewport;
      frameSequence: number;
    }
  | {
      type: "tap";
      point: PhonebasePoint;
      viewport: PhonebaseViewport;
      frameSequence: number;
      durationMs?: number;
      touchZ?: number;
    }
  | {
      type: "long_press";
      point: PhonebasePoint;
      viewport: PhonebaseViewport;
      frameSequence: number;
      durationMs: number;
      touchZ?: number;
    }
  | {
      type: "swipe";
      start: PhonebasePoint;
      end: PhonebasePoint;
      viewport: PhonebaseViewport;
      frameSequence: number;
      durationMs: number;
      touchZ?: number;
    }
  | { type: "input_text"; text: string; touchZ?: number }
  | { type: "phone_key"; key: "back" | "home" | "enter"; touchZ?: number }
  | { type: "wait"; durationMs: number };

export type PhonebaseActionEnvelope = {
  idempotencyKey: string;
  action: PhonebaseSemanticAction;
};

export type PhonebaseActionAvailability = {
  available: boolean;
  reason?: string;
  supportedKeys?: readonly ("back" | "home" | "enter")[];
};

export type PhonebaseCapabilities = {
  protocolVersion: "2026-07-29";
  observation: {
    screenshot: PhonebaseActionAvailability;
    liveFrames: PhonebaseActionAvailability;
    uiHierarchy: PhonebaseActionAvailability;
  };
  actions: Record<PhonebaseActionType, PhonebaseActionAvailability>;
};

export class PhonebaseActionValidationError extends Error {
  readonly code = "INVALID_ACTION";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new PhonebaseActionValidationError(
      `${label} contains unsupported field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}.`,
    );
  }
}

function finiteNumber(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PhonebaseActionValidationError(`${label} must be a finite number.`);
  }
  const parsed = value;
  if (options.min !== undefined && parsed < options.min) {
    throw new PhonebaseActionValidationError(`${label} must be at least ${options.min}.`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new PhonebaseActionValidationError(`${label} must be at most ${options.max}.`);
  }
  return parsed;
}

function integer(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): number {
  const parsed = finiteNumber(value, label, options);
  if (!Number.isSafeInteger(parsed)) {
    throw new PhonebaseActionValidationError(`${label} must be a safe integer.`);
  }
  return parsed;
}

function nonEmptyString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PhonebaseActionValidationError(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new PhonebaseActionValidationError(`${label} exceeds ${maxLength} characters.`);
  }
  return normalized;
}

function literalText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PhonebaseActionValidationError("text is required.");
  }
  if (value.length > PHONEBASE_MAX_TEXT_LENGTH) {
    throw new PhonebaseActionValidationError(`text exceeds ${PHONEBASE_MAX_TEXT_LENGTH} characters.`);
  }
  return value;
}

function viewport(value: unknown): PhonebaseViewport {
  const record = asRecord(value);
  assertOnlyKeys(record, ["width", "height"], "viewport");
  return {
    width: finiteNumber(record.width, "viewport.width", { min: 64, max: 8192 }),
    height: finiteNumber(record.height, "viewport.height", { min: 64, max: 8192 }),
  };
}

function point(value: unknown, field: string, size: PhonebaseViewport): PhonebasePoint {
  const record = asRecord(value);
  assertOnlyKeys(record, ["x", "y"], field);
  return {
    x: finiteNumber(record.x, `${field}.x`, { min: 0, max: size.width }),
    y: finiteNumber(record.y, `${field}.y`, { min: 0, max: size.height }),
  };
}

function touchContext(record: Record<string, unknown>) {
  const size = viewport(record.viewport);
  return {
    viewport: size,
    frameSequence: integer(record.frameSequence, "frameSequence", { min: 1 }),
  };
}

function optionalTouchZ(record: Record<string, unknown>) {
  return record.touchZ === undefined
    ? {}
    : {
        touchZ: finiteNumber(record.touchZ, "touchZ", {
          min: -20,
          max: 20,
        }),
      };
}

export function parsePhonebaseActionEnvelope(value: unknown): PhonebaseActionEnvelope {
  const envelope = asRecord(value);
  assertOnlyKeys(envelope, ["idempotencyKey", "action"], "request");
  const idempotencyKey = nonEmptyString(
    envelope.idempotencyKey,
    "idempotencyKey",
    160,
  );
  const actionRecord = asRecord(envelope.action);
  const type = nonEmptyString(actionRecord.type, "action.type", 40);
  if (!PHONEBASE_ACTION_TYPES.includes(type as PhonebaseActionType)) {
    throw new PhonebaseActionValidationError(`Unsupported action type: ${type}.`);
  }

  const allowedFields: Record<PhonebaseActionType, readonly string[]> = {
    status: ["type"],
    hold: ["type"],
    resume: ["type"],
    home: ["type", "confirmation"],
    wait: ["type", "durationMs"],
    input_text: ["type", "text", "touchZ"],
    phone_key: ["type", "key", "touchZ"],
    hover_move: ["type", "point", "viewport", "frameSequence"],
    tap: ["type", "point", "viewport", "frameSequence", "durationMs", "touchZ"],
    long_press: ["type", "point", "viewport", "frameSequence", "durationMs", "touchZ"],
    swipe: ["type", "start", "end", "viewport", "frameSequence", "durationMs", "touchZ"],
  };
  assertOnlyKeys(actionRecord, allowedFields[type as PhonebaseActionType], "action");

  let action: PhonebaseSemanticAction;
  if (type === "status" || type === "hold" || type === "resume") {
    action = { type };
  } else if (type === "home") {
    const confirmation = nonEmptyString(
      actionRecord.confirmation,
      "confirmation",
      80,
    );
    if (confirmation !== "CLEAR_WORKSPACE_AND_HOME") {
      throw new PhonebaseActionValidationError(
        "Home requires confirmation CLEAR_WORKSPACE_AND_HOME.",
      );
    }
    action = { type, confirmation };
  } else if (type === "wait") {
    action = {
      type,
      durationMs: integer(actionRecord.durationMs, "durationMs", {
        min: 0,
        max: 5_000,
      }),
    };
  } else if (type === "input_text") {
    action = {
      type,
      text: literalText(actionRecord.text),
      ...optionalTouchZ(actionRecord),
    };
  } else if (type === "phone_key") {
    const key = nonEmptyString(actionRecord.key, "key", 20);
    if (key !== "back" && key !== "home" && key !== "enter") {
      throw new PhonebaseActionValidationError(`Unsupported phone key: ${key}.`);
    }
    action = { type, key, ...optionalTouchZ(actionRecord) };
  } else if (type === "swipe") {
    const context = touchContext(actionRecord);
    action = {
      type,
      ...context,
      ...optionalTouchZ(actionRecord),
      start: point(actionRecord.start, "start", context.viewport),
      end: point(actionRecord.end, "end", context.viewport),
      durationMs: integer(actionRecord.durationMs ?? 500, "durationMs", {
        min: 250,
        max: 3_000,
      }),
    };
  } else if (type === "hover_move") {
    const context = touchContext(actionRecord);
    action = {
      type,
      ...context,
      point: point(actionRecord.point, "point", context.viewport),
    };
  } else {
    const context = touchContext(actionRecord);
    const touchType: "tap" | "long_press" = type === "long_press"
      ? "long_press"
      : "tap";
    const durationMs = integer(
      actionRecord.durationMs ?? (
        touchType === "long_press" ? 800 : PHONEBASE_TAP_DEFAULT_DURATION_MS
      ),
      "durationMs",
      {
        min: touchType === "long_press" ? 500 : PHONEBASE_TAP_MIN_DURATION_MS,
        max: touchType === "long_press" ? 5_000 : PHONEBASE_TAP_MAX_DURATION_MS,
      },
    );
    action = {
      type: touchType,
      ...context,
      ...optionalTouchZ(actionRecord),
      point: point(actionRecord.point, "point", context.viewport),
      durationMs,
    };
  }

  return { idempotencyKey, action };
}

export function normalizePhonebasePoint(
  pointValue: PhonebasePoint,
  viewportValue: PhonebaseViewport,
): PhonebasePoint {
  return {
    x: pointValue.x / viewportValue.width,
    y: pointValue.y / viewportValue.height,
  };
}

export function buildPhonebaseCapabilities(input: {
  frameReady: boolean;
  calibrationReady: boolean;
  homeReady?: boolean;
  homeReason?: string;
  resumeReady?: boolean;
  resumeReason?: string;
  longPressReady?: boolean;
  swipeReady?: boolean;
  inputTextReady?: boolean;
  phoneKeys?: readonly ("back" | "home" | "enter")[];
}): PhonebaseCapabilities {
  const requiresFrame = input.frameReady
    ? { available: true }
    : { available: false, reason: "A fresh camera frame is required." };
  const calibrationReason = input.frameReady
    ? "Physical XY/Z calibration is required."
    : "A fresh camera frame and physical XY/Z calibration are required.";
  const physicalAction = input.frameReady && input.calibrationReady
    ? { available: true }
    : { available: false, reason: calibrationReason };

  return {
    protocolVersion: "2026-07-29",
    observation: {
      screenshot: requiresFrame,
      liveFrames: requiresFrame,
      uiHierarchy: {
        available: false,
        reason: "Physical phones are observed visually and do not expose Android UI XML.",
      },
    },
    actions: {
      status: { available: true },
      hold: { available: true },
      resume: input.resumeReady
        ? { available: true }
        : {
            available: false,
            reason: input.resumeReason ?? "A connected, homed controller in Hold is required.",
          },
      home: input.homeReady
        ? { available: true }
        : {
            available: false,
            reason: input.homeReason ?? "A connected idle controller that has not been homed is required.",
          },
      hover_move: physicalAction,
      tap: physicalAction,
      long_press: input.longPressReady
        ? physicalAction
        : {
            available: false,
            reason: "Long press requires a matching hardware gesture profile.",
          },
      swipe: input.swipeReady
        ? physicalAction
        : {
            available: false,
            reason: "Swipe requires a matching hardware gesture profile.",
          },
      input_text: input.inputTextReady
        ? physicalAction
        : {
            available: false,
            reason: "Text entry requires a calibrated 720×1560 iPhone screen.",
          },
      phone_key: (input.phoneKeys?.length ?? 0) > 0
        ? {
            ...physicalAction,
            ...(input.phoneKeys ? { supportedKeys: [...input.phoneKeys] } : {}),
          }
        : {
            available: false,
            reason: "Phone Back, Home, and Enter require calibrated gestures.",
          },
      wait: { available: true },
    },
  };
}
