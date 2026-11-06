export const OPENROUTER_JEV_MODEL = "typesafe/jev-1.14";
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function finiteFraction(value: unknown, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Jev returned an invalid ${name}.`);
  }
  return parsed;
}

export function buildJevLocateRequest(target: string, imageDataUrl: string) {
  const normalizedTarget = target.trim();
  if (!normalizedTarget || normalizedTarget.length > 120) {
    throw new Error("Target must contain 1 to 120 characters.");
  }
  if (!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)) {
    throw new Error("Jev requires a base64 PNG or JPEG data URL.");
  }
  return {
    model: OPENROUTER_JEV_MODEL,
    state: [
      "A rectified screenshot of an iPhone. Locate only controls that are clearly visible inside the phone screen.",
      { type: "image_url", image_url: { url: imageDataUrl } },
    ],
    questions: {
      target_visible: {
        type: "noul",
        instructions: `Is the UI control, icon, or text representing ${JSON.stringify(normalizedTarget)} clearly visible and unambiguous in the screenshot?`,
      },
      target_box: {
        type: "box",
        instructions: `the single visible UI control, icon, or text representing ${JSON.stringify(normalizedTarget)} in the iPhone screenshot`,
      },
    },
  };
}

export function parseJevLocateResponse(value: unknown) {
  const root = objectValue(value);
  const answers = objectValue(root.answers);
  const visible = objectValue(answers.target_visible);
  const located = objectValue(answers.target_box);
  const box = objectValue(located.box);
  const parsedBox = {
    top: finiteFraction(box.top, "box.top"),
    bottom: finiteFraction(box.bottom, "box.bottom"),
    left: finiteFraction(box.left, "box.left"),
    right: finiteFraction(box.right, "box.right"),
  };
  if (parsedBox.left >= parsedBox.right || parsedBox.top >= parsedBox.bottom) {
    throw new Error("Jev returned an inverted or empty box.");
  }
  const usage = objectValue(root.usage);
  return {
    model: String(root.model ?? OPENROUTER_JEV_MODEL),
    provider: String(root.provider ?? "TypeSafe"),
    visibleProbability: finiteFraction(visible.noul, "target visibility"),
    confidence: finiteFraction(located.confidence, "box confidence"),
    box: parsedBox,
    usage: {
      inputTokens: Math.max(0, Number(usage.input_tokens ?? 0) || 0),
      outputTokens: Math.max(0, Number(usage.output_tokens ?? 0) || 0),
      cost: Math.max(0, Number(usage.cost ?? 0) || 0),
    },
    requestId: String(root.id ?? ""),
  };
}

export function qualifyJevActionCandidate(input: {
  visibleProbability: number;
  confidence: number;
  box: { top: number; bottom: number; left: number; right: number };
  plannerPoint?: { x: number; y: number };
}) {
  const boxWidth = input.box.right - input.box.left;
  const boxHeight = input.box.bottom - input.box.top;
  const boxArea = boxWidth * boxHeight;
  const validTargetSize = boxArea >= 0.0002 && boxArea <= 0.08;
  const plannerAgreement = Boolean(
    input.plannerPoint &&
    input.plannerPoint.x >= input.box.left &&
    input.plannerPoint.x <= input.box.right &&
    input.plannerPoint.y >= input.box.top &&
    input.plannerPoint.y <= input.box.bottom,
  );
  const jevQualified = validTargetSize && (
    (input.visibleProbability >= 0.9 && input.confidence >= 0.35) ||
    (input.visibleProbability >= 0.8 && input.confidence >= 0.55)
  );
  const plannerAssisted = validTargetSize && plannerAgreement &&
    input.visibleProbability >= 0.9 && input.confidence >= 0.3;
  return {
    safeToAct: jevQualified || plannerAssisted,
    qualifiedBy: jevQualified
      ? "jev" as const
      : plannerAssisted
        ? "planner+jev" as const
        : null,
    plannerAgreement,
    boxArea,
    point: {
      x: (input.box.left + input.box.right) / 2,
      y: (input.box.top + input.box.bottom) / 2,
    },
  };
}
