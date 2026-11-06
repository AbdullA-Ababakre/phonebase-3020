export type PhonebaseVisualAction =
  | { type: "tap_text"; target: string }
  | { type: "open_app"; appName: string };

export type PhonebaseVisualActionEnvelope = {
  idempotencyKey: string;
  action: PhonebaseVisualAction;
};

export class PhonebaseVisualActionValidationError extends Error {
  readonly code = "INVALID_VISUAL_ACTION";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new PhonebaseVisualActionValidationError(
      `${label} contains unsupported field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}.`,
    );
  }
}

function text(value: unknown, label: string, maximum = 80) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PhonebaseVisualActionValidationError(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new PhonebaseVisualActionValidationError(`${label} exceeds ${maximum} characters.`);
  }
  return normalized;
}

export function parsePhonebaseVisualActionEnvelope(
  value: unknown,
): PhonebaseVisualActionEnvelope {
  const envelope = record(value);
  onlyKeys(envelope, ["idempotencyKey", "action"], "request");
  const idempotencyKey = text(envelope.idempotencyKey, "idempotencyKey", 160);
  const action = record(envelope.action);
  const type = text(action.type, "action.type", 40);
  if (type === "tap_text") {
    onlyKeys(action, ["type", "target"], "action");
    return {
      idempotencyKey,
      action: { type, target: text(action.target, "action.target") },
    };
  }
  if (type === "open_app") {
    onlyKeys(action, ["type", "appName"], "action");
    return {
      idempotencyKey,
      action: { type, appName: text(action.appName, "action.appName") },
    };
  }
  throw new PhonebaseVisualActionValidationError(
    `Unsupported visual action type: ${type}.`,
  );
}
