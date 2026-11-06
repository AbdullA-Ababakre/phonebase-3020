import assert from "node:assert/strict";
import test from "node:test";
import {
  PHONEBASE_TAP_MAX_DURATION_MS,
  PHONEBASE_TAP_MIN_DURATION_MS,
} from "./action-contract";
import {
  phoneEnterKeyGesture,
  recoverableAgentExecutionFeedback,
} from "./phone-key-execution";

test("keeps the calibrated Enter key inside the physical tap-duration contract", () => {
  const gesture = phoneEnterKeyGesture();
  assert.deepEqual(gesture, {
    action: "tap",
    point: { x: 625, y: 1_388 },
    durationMs: 40,
  });
  assert.ok(gesture.durationMs >= PHONEBASE_TAP_MIN_DURATION_MS);
  assert.ok(gesture.durationMs <= PHONEBASE_TAP_MAX_DURATION_MS);
});

test("feeds safe executor rejections back to the planner without hiding hardware faults", () => {
  const learned = recoverableAgentExecutionFeedback(
    new Error("Tap duration must be within 30..40 ms; use long_press for longer contact."),
    "phone_key enter",
  );
  assert.match(learned ?? "", /safely rejected/i);
  assert.match(learned ?? "", /materially different valid strategy/i);
  assert.equal(
    recoverableAgentExecutionFeedback(
      new Error("The arm entered an alarm state."),
      "tap Send",
    ),
    null,
  );
});
