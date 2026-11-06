import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPhonebaseCapabilities,
  normalizePhonebasePoint,
  parsePhonebaseActionEnvelope,
  PhonebaseActionValidationError,
} from "./action-contract";

test("accepts a VMOS-style viewport tap and normalizes it", () => {
  const envelope = parsePhonebaseActionEnvelope({
    idempotencyKey: "agent-job-1-step-2",
    action: {
      type: "tap",
      point: { x: 540, y: 600 },
      viewport: { width: 1080, height: 2400 },
      frameSequence: 42,
    },
  });

  assert.equal(envelope.action.type, "tap");
  if (envelope.action.type !== "tap") return;
  assert.deepEqual(
    normalizePhonebasePoint(envelope.action.point, envelope.action.viewport),
    { x: 0.5, y: 0.25 },
  );
  assert.equal(envelope.action.durationMs, 40);
});

test("rejects unknown request, action, and coordinate fields", () => {
  assert.throws(
    () => parsePhonebaseActionEnvelope({
      idempotencyKey: "strict-envelope",
      action: { type: "status" },
      debug: true,
    }),
    /unsupported field: debug/,
  );
  assert.throws(
    () => parsePhonebaseActionEnvelope({
      idempotencyKey: "strict-action",
      action: {
        type: "tap",
        point: { x: 10, y: 20 },
        viewport: { width: 720, height: 1560 },
        frameSequence: 1,
        force: 1,
      },
    }),
    /unsupported field: force/,
  );
  assert.throws(
    () => parsePhonebaseActionEnvelope({
      idempotencyKey: "strict-point",
      action: {
        type: "tap",
        point: { x: 10, y: 20, z: 3 },
        viewport: { width: 720, height: 1560 },
        frameSequence: 1,
      },
    }),
    /unsupported field: z/,
  );
});

test("accepts an audited per-gesture touch depth", () => {
  const envelope = parsePhonebaseActionEnvelope({
    idempotencyKey: "human-pressure-1",
    action: {
      type: "tap",
      point: { x: 360, y: 780 },
      viewport: { width: 720, height: 1560 },
      frameSequence: 7,
      touchZ: 9.73,
    },
  });
  assert.equal(envelope.action.type, "tap");
  if (envelope.action.type !== "tap") return;
  assert.equal(envelope.action.touchZ, 9.73);
});

test("publishes the exact physical gesture duration limits", () => {
  const context = {
    point: { x: 360, y: 780 },
    viewport: { width: 720, height: 1560 },
    frameSequence: 7,
  };
  for (const action of [
    { type: "tap", ...context, durationMs: 41 },
    { type: "long_press", ...context, durationMs: 499 },
    {
      type: "swipe",
      start: context.point,
      end: { x: 400, y: 900 },
      viewport: context.viewport,
      frameSequence: context.frameSequence,
      durationMs: 3_001,
    },
  ]) {
    assert.throws(
      () => parsePhonebaseActionEnvelope({
        idempotencyKey: `duration-${action.type}`,
        action,
      }),
      PhonebaseActionValidationError,
    );
  }
});

test("accepts a calibrated hover target without a touch depth", () => {
  const envelope = parsePhonebaseActionEnvelope({
    idempotencyKey: "mouse-hover-1",
    action: {
      type: "hover_move",
      point: { x: 360, y: 780 },
      viewport: { width: 720, height: 1560 },
      frameSequence: 7,
    },
  });
  assert.deepEqual(envelope.action, {
    type: "hover_move",
    point: { x: 360, y: 780 },
    viewport: { width: 720, height: 1560 },
    frameSequence: 7,
  });
});

test("rejects touch points outside the declared viewport", () => {
  assert.throws(
    () => parsePhonebaseActionEnvelope({
      idempotencyKey: "bad-point",
      action: {
        type: "tap",
        point: { x: 1081, y: 600 },
        viewport: { width: 1080, height: 2400 },
        frameSequence: 42,
      },
    }),
    PhonebaseActionValidationError,
  );
});

test("requires an explicit clear-workspace confirmation before homing", () => {
  const envelope = parsePhonebaseActionEnvelope({
    idempotencyKey: "operator-home-1",
    action: {
      type: "home",
      confirmation: "CLEAR_WORKSPACE_AND_HOME",
    },
  });
  assert.deepEqual(envelope.action, {
    type: "home",
    confirmation: "CLEAR_WORKSPACE_AND_HOME",
  });
  assert.throws(
    () => parsePhonebaseActionEnvelope({
      idempotencyKey: "operator-home-unsafe",
      action: { type: "home" },
    }),
    PhonebaseActionValidationError,
  );
});

test("accepts an explicit non-motion resume action", () => {
  const envelope = parsePhonebaseActionEnvelope({
    idempotencyKey: "operator-resume-1",
    action: { type: "resume" },
  });
  assert.deepEqual(envelope.action, { type: "resume" });
});

test("accepts bounded text entry and phone navigation actions", () => {
  const text = parsePhonebaseActionEnvelope({
    idempotencyKey: "agent-text-1",
    action: { type: "input_text", text: "ASU", touchZ: 9.7 },
  });
  assert.deepEqual(text.action, {
    type: "input_text",
    text: "ASU",
    touchZ: 9.7,
  });
  const back = parsePhonebaseActionEnvelope({
    idempotencyKey: "agent-back-1",
    action: { type: "phone_key", key: "back" },
  });
  assert.deepEqual(back.action, { type: "phone_key", key: "back" });
  assert.throws(
    () => parsePhonebaseActionEnvelope({
      idempotencyKey: "agent-key-unsafe",
      action: { type: "phone_key", key: "volume_up" },
    }),
    PhonebaseActionValidationError,
  );
});

test("publishes physical actions as calibration-gated capabilities", () => {
  const gated = buildPhonebaseCapabilities({
    frameReady: true,
    calibrationReady: false,
  });
  assert.equal(gated.observation.screenshot.available, true);
  assert.equal(gated.actions.tap.available, false);
  assert.equal(gated.actions.hover_move.available, false);
  assert.match(gated.actions.tap.reason ?? "", /calibration/i);
  assert.equal(gated.actions.hold.available, true);
  assert.equal(gated.actions.resume.available, false);
  assert.equal(gated.actions.wait.available, true);
  assert.match(
    buildPhonebaseCapabilities({
      frameReady: true,
      calibrationReady: true,
      inputTextReady: false,
    }).actions.input_text.reason ?? "",
    /720×1560/i,
  );

  const gestureReady = buildPhonebaseCapabilities({
    frameReady: true,
    calibrationReady: true,
    homeReady: true,
    resumeReady: true,
    longPressReady: true,
    swipeReady: true,
    inputTextReady: true,
    phoneKeys: ["back", "enter"],
  });
  assert.equal(gestureReady.actions.long_press.available, true);
  assert.equal(gestureReady.actions.hover_move.available, true);
  assert.equal(gestureReady.actions.swipe.available, true);
  assert.equal(gestureReady.actions.home.available, true);
  assert.equal(gestureReady.actions.resume.available, true);
  assert.deepEqual(gestureReady.actions.phone_key.supportedKeys, ["back", "enter"]);
  assert.equal(gestureReady.actions.phone_key.supportedKeys?.includes("home"), false);
  assert.deepEqual(Object.keys(gestureReady.actions), [
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
  ]);
});
