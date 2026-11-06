import assert from "node:assert/strict";
import test from "node:test";
import { iosEnglishKeyboardSequence, iosPhoneKeypadSequence } from "./ios-keyboard";

test("turns letters, case, digits, punctuation and spaces into deterministic iOS taps", () => {
  const sequence = iosEnglishKeyboardSequence("aB 3!");
  assert.deepEqual(sequence.map((point) => point.key), [
    "a", "shift", "b", "space", "123", "3", "!", "ABC",
  ]);
  assert.deepEqual(
    sequence.filter((point) => point.delayAfterMs).map((point) => [point.key, point.delayAfterMs]),
    [["123", 300], ["ABC", 300]],
  );
});

test("never submits a form or guesses an unsupported keyboard", () => {
  assert.throws(() => iosEnglishKeyboardSequence("hello\n"), /key action/i);
  assert.throws(() => iosEnglishKeyboardSequence("你好"), /cannot type/i);
});

test("batches digits on the visible iOS phone keypad without toggling keyboard mode", () => {
  assert.deepEqual(iosPhoneKeypadSequence("4109"), [
    { x: 123, y: 1_161, key: "phone-4" },
    { x: 123, y: 1_058, key: "phone-1" },
    { x: 360, y: 1_369, key: "phone-0" },
    { x: 599, y: 1_265, key: "phone-9" },
  ]);
  assert.throws(() => iosPhoneKeypadSequence("41+"), /digits only/i);
});

test("uses strict device key overrides and rejects every uncalibrated key", () => {
  const calibration = {
    strict: true,
    points: {
      shift: { x: 10, y: 1405 },
      a: { x: 10, y: 1222 },
      s: { x: 80, y: 1222 },
      u: { x: 475, y: 1129 },
    },
  };
  assert.deepEqual(
    iosEnglishKeyboardSequence("ASU", calibration),
    [
      { key: "shift", x: 10, y: 1405 },
      { key: "a", x: 10, y: 1222 },
      { key: "shift", x: 10, y: 1405 },
      { key: "s", x: 80, y: 1222 },
      { key: "shift", x: 10, y: 1405 },
      { key: "u", x: 475, y: 1129 },
    ],
  );
  assert.throws(
    () => iosEnglishKeyboardSequence("B", calibration),
    /not calibrated/i,
  );
});
