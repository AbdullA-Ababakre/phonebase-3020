export const DEFAULT_PHONE_AGENT_MODEL = "openai/gpt-6.1-sol";
export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

export type PhoneAgentAction =
  | { type: "open_app"; appName: string; x: number; y: number }
  | { type: "tap_text"; target: string; x: number; y: number }
  | { type: "tap"; x: number; y: number; target: string }
  | { type: "long_press"; x: number; y: number; durationMs: number; target: string }
  | { type: "swipe"; startX: number; startY: number; endX: number; endY: number; durationMs: number; target: string }
  | { type: "input_text"; text: string }
  | { type: "phone_key"; key: "back" | "home" | "enter" }
  | { type: "wait"; durationMs: number }
  | { type: "none" };

export type PhoneAgentDecision = {
  status: "continue" | "done" | "blocked";
  summary: string;
  action: PhoneAgentAction;
  usage: { inputTokens: number; outputTokens: number; cost: number };
  model: string;
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function boundedString(value: unknown, name: string, maximum = 160) {
  const parsed = String(value ?? "").trim();
  if (!parsed || parsed.length > maximum) throw new Error(`Phone agent returned invalid ${name}.`);
  return parsed;
}

function fraction(value: unknown, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Phone agent returned invalid ${name}.`);
  }
  return parsed;
}

export function buildPhoneAgentRequest(input: {
  model?: string;
  goal: string;
  imageDataUrl: string;
  step: number;
  history: Array<{ action: string; outcome: string; summary?: string }>;
}) {
  const goal = boundedString(input.goal, "goal", 500);
  if (!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(input.imageDataUrl)) {
    throw new Error("Phone agent requires a base64 PNG or JPEG data URL.");
  }
  const recentHistory = input.history.slice(-12);
  const failedStrategies = recentHistory
    .filter((entry) => /(?:did not qualify|could not execute|failed|rejected|no visible change)/iu.test(entry.outcome))
    .map((entry) => ({ action: entry.action, outcome: entry.outcome }))
    .slice(-6);
  const verifiedProgress = recentHistory
    .filter((entry) => /completed|succeeded/iu.test(entry.outcome) && entry.summary)
    .map((entry) => entry.summary)
    .slice(-8);
  const body = {
    embodiment: "A calibrated XY/Z robotic arm moves a physical conductive stylus over a real iPhone.",
    observation: "One fresh rectified camera or wired-video screenshot; no accessibility tree and no direct iOS API.",
    actions: {
      tap: "One short physical stylus contact. It can never perform a long press.",
      long_press: "One continuous physical stylus contact for 500-3000 ms.",
      swipe: "One continuous physical drag between two normalized screen points.",
      input_text: "A deterministic sequence of physical keyboard taps. It is slow, so provide the complete final text once and keep it concise.",
      phone_key: "A calibrated phone navigation action; home means iPhone Home, never mechanical homing.",
      wait: "Observe without touching for at most 5000 ms.",
    },
    constraints: [
      "Every visual action is re-localized on the fresh frame by Jev before the stylus moves.",
      "The arm has no hidden ability: wording such as 'long press' inside a tap target does not change a tap into a long press.",
      "A failed strategy must cause a materially different action type, target, or navigation route on the next attempt.",
    ],
  };
  return {
    model: input.model || DEFAULT_PHONE_AGENT_MODEL,
    messages: [
      {
        role: "system",
        content: [
          "You control one physical iPhone through a safe action executor.",
          "Treat the supplied body contract as your actual body, not as a metaphor. Never claim an action semantic that differs from the selected action type.",
          "Return exactly one next action. Prefer open_app and tap_text over coordinates.",
          "Write summary and visual target descriptions in English, even when the user's goal is written in another language.",
          "Coordinates x and y are normalized from 0 to 1 in the supplied screenshot.",
          "Every open_app, tap_text, tap, or long_press target is independently localized by Jev before execution. Describe the target visually and unambiguously. Put your best estimate of its center in x and y for telemetry; Jev has final authority over the executed contact location.",
          "Use long_press only when continuous contact is required. A tap whose target description says long press is still only a tap and is invalid planning.",
          "If an app icon is not visible, recover by swiping between Home Screen pages or swiping down for Spotlight search. Use normalized swipe coordinates.",
          "When a standard iOS keyboard is visible, use one input_text action for the complete value. Never tap keyboard letters individually.",
          "Because every character is a physical arm motion, keep ordinary messages at 80 characters or fewer when the user's meaning can be preserved. Prefer plain words and minimal punctuation.",
          "The calibrated physical keyboard supports English letters, digits, spaces, and common punctuation only.",
          "Never loop on a cosmetic case-only difference. Try correcting capitalization at most once, then continue unless the goal explicitly says the casing itself is material.",
          "When recentHistory shows that an action failed or Jev rejected it, diagnose why from the new screenshot and choose a materially different strategy. Never repeat the same physical strategy with merely reworded target text.",
          "Treat verifiedProgress as durable task memory. Do not reopen an app or repeat research merely to reconfirm a fact already recorded there unless a newer observation contradicts it. Advance to the next unfinished part of the goal.",
          "Do not invent success. Return done only when the screenshot visibly verifies the goal.",
          "For messages or other external side effects, act only when the goal explicitly requests the send/post/purchase action. Before tapping Send, verify the intended recipient and composed content are visibly correct.",
          "After sending a message, never report success if the screen shows Not Delivered, Message Send Failure, Send Failed, a red error icon, or an equivalent delivery error.",
          "If the requested target, recipient, or state is ambiguous, return blocked. Never request mechanical homing.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({ goal, step: input.step, body, recentHistory, verifiedProgress, failedStrategies }),
          },
          { type: "image_url", image_url: { url: input.imageDataUrl, detail: "high" } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "phone_agent_next_action",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["status", "summary", "action"],
          properties: {
            status: { type: "string", enum: ["continue", "done", "blocked"] },
            summary: { type: "string", minLength: 1, maxLength: 240 },
            action: {
              type: "object",
              additionalProperties: false,
              required: ["type", "appName", "target", "text", "x", "y", "startX", "startY", "endX", "endY", "key", "durationMs"],
              properties: {
                type: { type: "string", enum: ["open_app", "tap_text", "tap", "long_press", "swipe", "input_text", "phone_key", "wait", "none"] },
                appName: { type: "string", maxLength: 80 },
                target: { type: "string", maxLength: 120 },
                text: { type: "string", maxLength: 120 },
                x: { type: "number", minimum: 0, maximum: 1 },
                y: { type: "number", minimum: 0, maximum: 1 },
                startX: { type: "number", minimum: 0, maximum: 1 },
                startY: { type: "number", minimum: 0, maximum: 1 },
                endX: { type: "number", minimum: 0, maximum: 1 },
                endY: { type: "number", minimum: 0, maximum: 1 },
                key: { type: "string", enum: ["", "back", "home", "enter"] },
                durationMs: { type: "integer", minimum: 0, maximum: 5000 },
              },
            },
          },
        },
      },
    },
    temperature: 0,
  };
}

export function parsePhoneAgentResponse(value: unknown): PhoneAgentDecision {
  const root = objectValue(value);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const message = objectValue(objectValue(choices[0]).message);
  const rawContent = message.content;
  const content = typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((part) => String(objectValue(part).text ?? "")).join("")
      : "";
  let parsed: JsonObject;
  try {
    parsed = objectValue(JSON.parse(content));
  } catch {
    throw new Error("Phone agent did not return valid structured JSON.");
  }
  const status = String(parsed.status ?? "");
  if (status !== "continue" && status !== "done" && status !== "blocked") {
    throw new Error("Phone agent returned an invalid status.");
  }
  const rawAction = objectValue(parsed.action);
  const type = String(rawAction.type ?? "");
  let action: PhoneAgentAction;
  if (type === "open_app") action = {
    type,
    appName: boundedString(rawAction.appName, "appName", 80),
    x: fraction(rawAction.x, "open_app.x"),
    y: fraction(rawAction.y, "open_app.y"),
  };
  else if (type === "tap_text") action = {
    type,
    target: boundedString(rawAction.target, "target", 120),
    x: fraction(rawAction.x, "tap_text.x"),
    y: fraction(rawAction.y, "tap_text.y"),
  };
  else if (type === "tap") action = {
    type,
    x: fraction(rawAction.x, "tap.x"),
    y: fraction(rawAction.y, "tap.y"),
    target: boundedString(rawAction.target, "tap target", 120),
  };
  else if (type === "long_press") {
    const durationMs = Number(rawAction.durationMs);
    if (!Number.isInteger(durationMs) || durationMs < 500 || durationMs > 3_000) {
      throw new Error("Phone agent returned an invalid long-press duration.");
    }
    action = {
      type,
      x: fraction(rawAction.x, "long_press.x"),
      y: fraction(rawAction.y, "long_press.y"),
      durationMs,
      target: boundedString(rawAction.target, "long-press target", 120),
    };
  }
  else if (type === "swipe") {
    const durationMs = Number(rawAction.durationMs);
    if (!Number.isInteger(durationMs) || durationMs < 250 || durationMs > 3_000) {
      throw new Error("Phone agent returned an invalid swipe duration.");
    }
    action = {
      type,
      startX: fraction(rawAction.startX, "swipe.startX"),
      startY: fraction(rawAction.startY, "swipe.startY"),
      endX: fraction(rawAction.endX, "swipe.endX"),
      endY: fraction(rawAction.endY, "swipe.endY"),
      durationMs,
      target: boundedString(rawAction.target, "swipe target", 120),
    };
  }
  else if (type === "input_text") action = { type, text: boundedString(rawAction.text, "text", 120) };
  else if (type === "phone_key") {
    const key = String(rawAction.key ?? "");
    if (key !== "back" && key !== "home" && key !== "enter") throw new Error("Phone agent returned an invalid phone key.");
    action = { type, key };
  } else if (type === "wait") {
    const durationMs = Number(rawAction.durationMs);
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 5_000) throw new Error("Phone agent returned an invalid wait duration.");
    action = { type, durationMs };
  } else if (type === "none") action = { type };
  else throw new Error("Phone agent returned an unsupported action.");
  if (status === "continue" && action.type === "none") {
    throw new Error("Phone agent returned continue without an action.");
  }
  if (status !== "continue" && action.type !== "none") {
    throw new Error("Phone agent returned a terminal status with a physical action.");
  }
  const usage = objectValue(root.usage);
  return {
    status,
    summary: boundedString(parsed.summary, "summary", 240),
    action,
    usage: {
      inputTokens: Math.max(0, Number(usage.prompt_tokens ?? 0) || 0),
      outputTokens: Math.max(0, Number(usage.completion_tokens ?? 0) || 0),
      cost: Math.max(0, Number(usage.cost ?? 0) || 0),
    },
    model: String(root.model ?? DEFAULT_PHONE_AGENT_MODEL),
  };
}
