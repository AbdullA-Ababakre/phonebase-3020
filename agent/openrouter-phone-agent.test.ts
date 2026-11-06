import assert from "node:assert/strict";
import test from "node:test";
import { buildPhoneAgentRequest, parsePhoneAgentResponse } from "./openrouter-phone-agent";

test("builds a screenshot-grounded phone-agent request with strict one-action output", () => {
  const request = buildPhoneAgentRequest({
    goal: "Message Alex that I will be ten minutes late",
    imageDataUrl: "data:image/jpeg;base64,AA==",
    step: 1,
    history: [{ action: "open_app Weather", outcome: "completed", summary: "Forecast verified: rain, 54–66°F." }],
  });
  assert.equal(request.messages[1].content[1].type, "image_url");
  assert.equal(request.response_format.json_schema.strict, true);
  assert.match(request.messages[0].content, /Never tap keyboard letters individually/);
  assert.match(request.messages[0].content, /80 characters or fewer/);
  assert.match(request.messages[0].content, /Spotlight search/);
  assert.match(request.messages[0].content, /Jev has final authority/);
  assert.match(request.messages[0].content, /Never loop on a cosmetic case-only difference/);
  assert.match(request.messages[0].content, /actual body, not as a metaphor/);
  assert.match(request.messages[0].content, /A tap whose target description says long press/);
  assert.match(request.messages[1].content[0].text, /robotic arm/);
  assert.match(request.messages[1].content[0].text, /verifiedProgress/);
  assert.match(request.messages[1].content[0].text, /Forecast verified/);
});

test("parses exactly one normalized tap and terminal decisions", () => {
  const wrap = (decision: unknown) => ({
    model: "openai/gpt-5.6-luna",
    choices: [{ message: { content: JSON.stringify(decision) } }],
    usage: { prompt_tokens: 200, completion_tokens: 20, cost: 0.000064 },
  });
  const next = parsePhoneAgentResponse(wrap({
    status: "continue",
    summary: "Tap compose",
    action: { type: "tap", appName: "", target: "Compose", text: "", x: 0.91, y: 0.08, key: "", durationMs: 0 },
  }));
  assert.deepEqual(next.action, { type: "tap", target: "Compose", x: 0.91, y: 0.08 });
  assert.equal(next.usage.cost, 0.000064);
  const openApp = parsePhoneAgentResponse(wrap({
    status: "continue",
    summary: "Open Messages",
    action: { type: "open_app", appName: "Messages", target: "", text: "", x: 0.6, y: 0.92, key: "", durationMs: 0 },
  }));
  assert.deepEqual(openApp.action, { type: "open_app", appName: "Messages", x: 0.6, y: 0.92 });
  const done = parsePhoneAgentResponse(wrap({
    status: "done",
    summary: "Message is visible as sent",
    action: { type: "none", appName: "", target: "", text: "", x: 0, y: 0, key: "", durationMs: 0 },
  }));
  assert.equal(done.status, "done");
  const swipe = parsePhoneAgentResponse(wrap({
    status: "continue",
    summary: "Open Spotlight search",
    action: {
      type: "swipe",
      appName: "",
      target: "Spotlight search",
      text: "",
      x: 0,
      y: 0,
      startX: 0.5,
      startY: 0.25,
      endX: 0.5,
      endY: 0.7,
      key: "",
      durationMs: 450,
    },
  }));
  assert.deepEqual(swipe.action, {
    type: "swipe",
    startX: 0.5,
    startY: 0.25,
    endX: 0.5,
    endY: 0.7,
    durationMs: 450,
    target: "Spotlight search",
  });
  const longPress = parsePhoneAgentResponse(wrap({
    status: "continue",
    summary: "Open the text editing menu",
    action: {
      type: "long_press",
      appName: "",
      target: "message draft text",
      text: "",
      x: 0.45,
      y: 0.56,
      startX: 0,
      startY: 0,
      endX: 0,
      endY: 0,
      key: "",
      durationMs: 800,
    },
  }));
  assert.deepEqual(longPress.action, {
    type: "long_press",
    target: "message draft text",
    x: 0.45,
    y: 0.56,
    durationMs: 800,
  });
  assert.throws(() => parsePhoneAgentResponse(wrap({
    status: "continue",
    summary: "No action",
    action: { type: "none", appName: "", target: "", text: "", x: 0, y: 0, key: "", durationMs: 0 },
  })), /without an action/i);
});
