import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRemoteActionAllowed,
  assertRenterActionAllowed,
  assertVisualActionAllowed,
  REMOTE_ACTION_TYPES,
} from "./remote_gateway_policy";

test("remote gateway exposes the complete safety-gated human control surface", () => {
  for (const type of REMOTE_ACTION_TYPES) {
    const action = type === "home"
      ? { type, confirmation: "CLEAR_WORKSPACE_AND_HOME" }
      : { type };
    assert.equal(
      assertRemoteActionAllowed(Buffer.from(JSON.stringify({ action }))),
      type,
    );
  }
});

test("remote gateway permits only bounded OCR visual actions", () => {
  assert.equal(assertVisualActionAllowed(Buffer.from(JSON.stringify({
    idempotencyKey: "weather-step",
    action: { type: "open_app", appName: "Weather" },
  }))), "open_app");
  assert.equal(assertVisualActionAllowed(Buffer.from(JSON.stringify({
    idempotencyKey: "continue-step",
    action: { type: "tap_text", target: "Continue" },
  }))), "tap_text");
  assert.throws(() => assertVisualActionAllowed(Buffer.from(JSON.stringify({
    idempotencyKey: "unsafe-step",
    action: { type: "shell", target: "Continue" },
  }))), /unavailable/);
});

test("remote gateway rejects unsupported actions", () => {
  assert.throws(
    () => assertRemoteActionAllowed(Buffer.from('{"action":{"type":"shell"}}')),
    /Remote action is unavailable: shell/,
  );
});

test("remote mechanical Home requires the exact human confirmation", () => {
  assert.throws(
    () => assertRemoteActionAllowed(Buffer.from('{"action":{"type":"home"}}')),
    /explicit physical-workspace confirmation/,
  );
});

test("renters can use phone Home but cannot home the mechanical arm", () => {
  assert.equal(
    assertRenterActionAllowed(Buffer.from(
      '{"action":{"type":"phone_key","key":"home"}}',
    )),
    "phone_key",
  );
  assert.throws(
    () => assertRenterActionAllowed(Buffer.from(JSON.stringify({
      action: { type: "home", confirmation: "CLEAR_WORKSPACE_AND_HOME" },
    }))),
    /local station administrator/,
  );
});
