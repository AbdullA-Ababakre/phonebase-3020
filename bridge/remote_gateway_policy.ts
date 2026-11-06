export const REMOTE_ACTION_TYPES = [
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

const REMOTE_ACTION_TYPE_SET = new Set<string>(REMOTE_ACTION_TYPES);

export function assertRemoteActionAllowed(body: Buffer) {
  const value = JSON.parse(body.toString("utf8")) as {
    action?: { type?: unknown; confirmation?: unknown };
  };
  const type = String(value.action?.type ?? "");
  if (!REMOTE_ACTION_TYPE_SET.has(type)) {
    throw new Error(`Remote action is unavailable: ${type || "missing"}`);
  }
  if (
    type === "home" &&
    value.action?.confirmation !== "CLEAR_WORKSPACE_AND_HOME"
  ) {
    throw new Error("Remote Home requires explicit physical-workspace confirmation");
  }
  return type;
}

export function assertRenterActionAllowed(body: Buffer) {
  const type = assertRemoteActionAllowed(body);
  if (type === "home") {
    throw new Error(
      "Mechanical Home is restricted to the local station administrator.",
    );
  }
  return type;
}

export function assertVisualActionAllowed(body: Buffer) {
  const value = JSON.parse(body.toString("utf8")) as {
    idempotencyKey?: unknown;
    action?: { type?: unknown; target?: unknown; appName?: unknown };
  };
  if (typeof value.idempotencyKey !== "string" || !value.idempotencyKey.trim() || value.idempotencyKey.length > 160) {
    throw new Error("Visual action requires a bounded idempotency key");
  }
  const type = String(value.action?.type ?? "");
  if (type !== "tap_text" && type !== "open_app") {
    throw new Error(`Remote visual action is unavailable: ${type || "missing"}`);
  }
  const target = type === "open_app" ? value.action?.appName : value.action?.target;
  if (typeof target !== "string" || !target.trim() || target.length > 80) {
    throw new Error("Remote visual action requires a bounded visible target");
  }
  return type;
}
