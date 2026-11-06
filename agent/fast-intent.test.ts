import assert from "node:assert/strict";
import test from "node:test";

import {
  locateVisibleText,
  looksLikeIosKeyboard,
  looksLikeIosPhoneKeypad,
  requestedClickTarget,
  requestedTextInput,
  requestedSwipe,
  requestsTopLeftClose,
  signaturesDiffer,
  visibleMessageDeliveryFailure,
} from "./fast-intent";

const ocrItem = (text: string) => ({
  text,
  confidence: 1,
  left: 10,
  top: 10,
  width: 80,
  height: 20,
  centerX: 50,
  centerY: 20,
});

test("parses visible click, close, and directional swipe intents", () => {
  assert.equal(requestedClickTarget("点击左上角的 X，关闭当前浏览器"), "X");
  assert.equal(requestedClickTarget("Please click the Continue button"), "Continue");
  assert.equal(requestsTopLeftClose("点击左上角的 X，关闭当前浏览器"), true);
  const swipe = requestedSwipe("向下滚动一次", { width: 720, height: 1_560 });
  assert.equal(swipe?.name, "scroll down");
  assert.deepEqual(swipe?.start, { x: 360, y: 1_154.4 });
  assert.ok(Math.abs(Number(swipe?.end.y) - 436.8) < 0.001);
});

test("parses bounded natural-language text entry", () => {
  assert.deepEqual(requestedTextInput("在 Message 输入框输入 ASU"), {
    field: "Message",
    text: "ASU",
  });
  assert.deepEqual(requestedTextInput('Type "hello" into the Search field'), {
    field: "Search",
    text: "hello",
  });
});

test("detects a meaningful OCR text change", () => {
  assert.equal(signaturesDiffer(new Set(["one", "two"]), new Set(["one", "three"])), true);
  assert.equal(signaturesDiffer(new Set(["one", "two"]), new Set(["one", "two"])), false);
});

test("recognizes an OCR keyboard without relying on screen colors", () => {
  const keys = "qwertyuiop".split("").map((text, index) => ({
    text,
    confidence: 0.9,
    left: index * 20,
    top: 700,
    width: 12,
    height: 18,
    centerX: index * 20 + 6,
    centerY: 720,
  }));
  assert.equal(looksLikeIosKeyboard({
    ok: true,
    imageWidth: 473,
    imageHeight: 1_024,
    elapsedMs: 10,
    items: keys,
  }), true);
});

test("distinguishes the iOS phone keypad from the QWERTY number page", () => {
  const labels = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "ABC", "DEF", "GHI", "JKL", "MNO"];
  assert.equal(looksLikeIosPhoneKeypad({
    ok: true,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: labels.map((text, index) => ({
      text,
      confidence: 0.9,
      left: 10,
      top: 1_000 + index,
      width: 20,
      height: 20,
      centerX: 20,
      centerY: 1_020 + index,
    })),
  }), true);
});

test("detects a visible message delivery failure before an Agent can claim success", () => {
  const result = {
    ok: true as const,
    imageWidth: 720,
    imageHeight: 1_560,
    elapsedMs: 10,
    items: [ocrItem("Not Delivered")],
  };
  assert.equal(visibleMessageDeliveryFailure(result), "Not Delivered");
  assert.equal(visibleMessageDeliveryFailure({ ...result, items: [ocrItem("Delivered")] }), null);
});

test("finds a short requested token when OCR merges it with an adjacent icon", () => {
  const match = locateVisibleText("ASU", {
    ok: true,
    imageWidth: 720,
    imageHeight: 1560,
    elapsedMs: 10,
    items: [ocrItem("Q ASU")],
  }, { width: 720, height: 1560 });
  assert.equal(match?.recognizedLabel, "Q ASU");
  assert.equal(
    locateVisibleText("ASU", {
      ok: true,
      imageWidth: 720,
      imageHeight: 1560,
      elapsedMs: 10,
      items: [ocrItem("CASUAL")],
    }, { width: 720, height: 1560 }),
    null,
  );
});
