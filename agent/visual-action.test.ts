import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePhonebaseVisualActionEnvelope,
  PhonebaseVisualActionValidationError,
} from "./visual-action";

test("accepts bounded server-side OCR actions", () => {
  assert.deepEqual(parsePhonebaseVisualActionEnvelope({
    idempotencyKey: "weather-step",
    action: { type: "open_app", appName: "Weather" },
  }), {
    idempotencyKey: "weather-step",
    action: { type: "open_app", appName: "Weather" },
  });
  assert.deepEqual(parsePhonebaseVisualActionEnvelope({
    idempotencyKey: "continue-step",
    action: { type: "tap_text", target: "Continue" },
  }).action, { type: "tap_text", target: "Continue" });
});

test("rejects unsupported visual actions and extra fields", () => {
  assert.throws(() => parsePhonebaseVisualActionEnvelope({
    idempotencyKey: "bad",
    action: { type: "shell", target: "Continue" },
  }), PhonebaseVisualActionValidationError);
  assert.throws(() => parsePhonebaseVisualActionEnvelope({
    idempotencyKey: "bad-extra",
    action: { type: "tap_text", target: "Continue", force: true },
  }), /unsupported field: force/);
});
