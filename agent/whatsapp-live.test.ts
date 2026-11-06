import test from "node:test";
import assert from "node:assert/strict";
import { assertObservedDevice, chatHeaderMatches, inboxRows, locateInboxChat, sameChatName, sameInboxLayout, stableInboxTarget, WHATSAPP_BACK } from "./whatsapp-navigation";
import { actionableReply, chatViewSchema, confirmedReply, conversationText, equivalentText, newInbound, outgoingFingerprint, pendingSendBlocks, permittedChat, replyPlanSchema, replySchema, SemanticChangeGate, typingChunks } from "./whatsapp-live-policy";
import { FrameRetryGate, chatHasUnresolvedSend, transientPreview } from "./whatsapp-live-recovery";
import type { VisionOcrResult } from "./vision-ocr";

const item = (text: string, left: number, y: number) => ({ text, left, top: y - 10, width: 100, height: 20, centerX: left + 50, centerY: y, confidence: 0.95 });
const inbox: VisionOcrResult = { ok: true, imageWidth: 720, imageHeight: 1560, elapsedMs: 10, items: [
  item("Chats", 314, 128), item("Calls", 188, 1482), item("You", 627, 1482),
  item("Sultan", 160, 315), item("2:08 PM", 577, 316), item("Hello Sultan!", 163, 356),
  item("Phoneuse - aun.ai", 160, 469), item("2:00 PM", 579, 470), item("You: Hi everyone", 163, 511),
] };
const view = chatViewSchema.parse({ kind: "chat", chatName: "Sultan", chatKind: "direct", keyboardVisible: false,
  composer: { text: "", point: { x: 300, y: 1448 } }, send: null, messages: [] });

test("Back uses the inset WhatsApp target, not the arrow edge", () => assert.deepEqual(WHATSAPP_BACK, { x: 66, y: 140 }));
test("chat row is anchored to title and time, never a matching message preview", () => {
  assert.equal(inboxRows(inbox).length, 2);
  assert.deepEqual(locateInboxChat(inbox, "Sultan"), { x: 240, y: 315 });
  assert.throws(() => locateInboxChat(inbox, "Hello Sultan!"));
  assert.throws(() => locateInboxChat({ ...inbox, imageWidth: 1080 }, "Sultan"));
});
test("duplicate names are ambiguous; header match excludes preview text", () => {
  assert.throws(() => locateInboxChat({ ...inbox, items: [...inbox.items, item("Sultan", 160, 680), item("2:09 PM", 577, 680)] }, "Sultan"));
  assert.equal(chatHeaderMatches(inbox, "Sultan"), false);
  assert.equal(chatHeaderMatches({ ...inbox, items: [item("Sultan", 205, 126)] }, "Sultan"), true);
});
test("expanded iOS title moves rows without breaking inbox detection", () => {
  const expanded = { ...inbox, items: inbox.items.map(i => i.text === "Chats" && i.centerY < 200
    ? { ...i, centerY: 220 } : i.centerY > 260 && i.centerY < 1000 ? { ...i, centerY: i.centerY + 200 } : i) };
  assert.deepEqual(locateInboxChat(expanded, "Sultan"), { x: 240, y: 515 });
});
test("new-message row reordering invalidates a previously valid point", () => {
  const reordered = { ...inbox, items: inbox.items.map(i => i.centerY > 260 && i.centerY < 430
    ? { ...i, centerY: i.centerY + 155 } : i.centerY >= 430 && i.centerY < 650 ? { ...i, centerY: i.centerY - 155 } : i) };
  assert.equal(stableInboxTarget(inbox, reordered, "Sultan"), null);
  assert.equal(sameInboxLayout(inbox, reordered), false);
  assert.equal(sameInboxLayout(reordered, reordered), true);
  assert.deepEqual(stableInboxTarget(reordered, reordered, "Sultan"), { x: 240, y: 470 });
});
test("phone-number identity tolerates formatting but never different digits", () => {
  assert.equal(sameChatName("+1 (951) 379-6597", "+1 951 379 6597"), true);
  assert.equal(sameChatName("+1 (951) 379-6597", "+1 951 379 6598"), false);
  assert.equal(sameChatName("Sultan", "Hello Sultan"), false);
});
test("only direct conversations and the exact authorized group are eligible", () => {
  assert.equal(permittedChat(view), true);
  assert.equal(permittedChat({ ...view, chatKind: "group" }), false);
  assert.equal(permittedChat({ ...view, chatKind: "unknown" }), false);
  assert.equal(permittedChat({ ...view, chatName: "Phoneuse - aun.ai", chatKind: "group" }), true);
});
test("old inbound, own bubbles and system notices cannot cause replies", () => {
  const message = (direction: "inbound" | "outbound" | "system", text: string) => ({ direction, text, sender: "", time: "", sentCheckmark: true });
  assert.deepEqual(newInbound({ ...view, messages: [message("inbound", "Hello"), message("outbound", "Hi"), message("system", "Today")] }), []);
  assert.equal(newInbound({ ...view, messages: [message("outbound", "Hi"), message("inbound", "How are you"), message("inbound", "Tell me a joke")] }).length, 2);
});
test("a queued message arriving during composition survives the next outgoing bubble", () => {
  const message = (direction: "inbound" | "outbound", text: string) => ({ direction, text, sender: "Sultan", time: "7:05 PM", sentCheckmark: true });
  const queued = message("inbound", "One more question");
  const after = { ...view, messages: [message("inbound", "Old question"), queued, message("outbound", "Answer to the old question")] };
  assert.deepEqual(newInbound(after), []);
  assert.deepEqual(newInbound(after, [queued]), [queued]);
});
test("typing dots and date labels do not invalidate a response but new message text does", () => {
  const before = { ...inbox, items: [item("What API do you run on?", 54, 700), item("...", 40, 1350), item("Today", 300, 180)] };
  const after = { ...before, items: [before.items[0]] };
  assert.equal(conversationText(before, false), conversationText(after, false));
  assert.notEqual(conversationText(before, false), conversationText({ ...after, items: [...after.items, item("New question", 54, 1000)] }, false));
});
test("an approval-required request gets a truthful acknowledgment without authorizing execution", () => {
  const reply = actionableReply({ decision: "needs_approval", text: "", reason: "External outreach" });
  assert.equal(reply.decision, "needs_approval");
  assert.equal(reply.text, "I need owner approval before taking that action.");
  assert.doesNotThrow(() => typingChunks(reply.text));
});
test("unchanged frames do not schedule model calls", () => {
  const gate = new SemanticChangeGate();
  assert.equal(gate.accept("same"), true);
  for (let i = 0; i < 1000; i++) assert.equal(gate.accept("same"), false);
  assert.equal(gate.accept("new message"), true);
});
test("uncertain sends and drafts remain blocking after recovery", () => {
  for (const status of ["drafting", "pending_send", "uncertain"]) assert.equal(pendingSendBlocks([{ status }]), true);
  assert.equal(pendingSendBlocks([{ status: "sent" }]), false);
});
test("a failed unchanged screen becomes eligible after backoff without a polling timer", () => {
  const retry = new FrameRetryGate(), gate = new SemanticChangeGate();
  assert.equal(gate.accept("same inbox"), true);
  retry.fail("Header temporarily unreadable", 1000);
  assert.equal(retry.ready(1999), false);
  assert.equal(retry.ready(2000), true);
  assert.equal(gate.accept("same inbox"), false);
  if (retry.pending) gate.reset();
  assert.equal(gate.accept("same inbox"), true);
  retry.succeed();
  assert.equal(retry.pending, false);
  assert.equal(gate.accept("same inbox"), false);
});
test("repeated failures back off and a successful attempt resets recovery", () => {
  const retry = new FrameRetryGate();
  for (let i = 0; i < 10; i++) retry.fail("Offline", 1000);
  assert.equal(retry.retryAt, 31000);
  retry.succeed(); retry.fail("Transient", 1000);
  assert.equal(retry.retryAt, 2000);
});
test("an uncertain send blocks its recipient without stopping other conversations", () => {
  const entries = [{ chat: "Sultan", status: "pending_send" }, { chat: "Phoneuse - aun.ai", status: "sent" }];
  assert.equal(chatHasUnresolvedSend(entries, "Sultan"), true);
  assert.equal(chatHasUnresolvedSend(entries, "Phoneuse - aun.ai"), false);
  assert.equal(chatHasUnresolvedSend([{ chat: "+1 (951) 379-6597", status: "uncertain" }], "+1 951 379 6597"), true);
});
test("typing indicators are not incoming messages", () => {
  for (const text of ["typing...", "typing…", "Sultan is typing...", "recording audio..."]) assert.equal(transientPreview(text), true);
  assert.equal(transientPreview("What can you do?"), false);
});
test("a combined read and reply plan retains strict view and response contracts", () => {
  assert.equal(replyPlanSchema.parse({ view, reply: { decision: "ignore", text: "", reason: "Already answered" } }).view.chatName, "Sultan");
  assert.throws(() => replyPlanSchema.parse({ view, reply: { decision: "execute", text: "", reason: "" } }));
});
test("send recovery requires a new latest checked bubble, not an older identical reply", () => {
  const old = { ...view, messages: [{ direction: "outbound" as const, sender: "", text: "Hello!", time: "2:00 PM", sentCheckmark: true }] };
  const previous = outgoingFingerprint(old);
  assert.equal(confirmedReply(old, "Hello!", previous), false);
  const sent = { ...old, messages: [...old.messages, { ...old.messages[0], time: "2:01 PM" }] };
  assert.equal(confirmedReply(sent, "Hello!", previous), true);
  assert.equal(confirmedReply(sent, "Hello!", undefined), false);
  assert.equal(confirmedReply({ ...sent, composer: { ...view.composer!, text: "Hello!" } }, "Hello!", previous), false);
});
test("typing splits punctuation at call boundaries and preserves spaces", () => {
  assert.deepEqual(typingChunks("Hi Sultan! I am ready."), ["Hi Sultan!", " i am ready."]);
  assert.equal(typingChunks("A very long message ".repeat(8).trim()).every(c => c.length <= 100), true);
  assert.throws(() => typingChunks("Send 💰"));
  assert.throws(() => typingChunks("a\nb"));
  assert.throws(() => typingChunks("O'Reilly"));
});
test("proofreading tolerates case only, not changed words or amounts", () => {
  assert.equal(equivalentText("Hello Sultan!", "hello Sultan!"), true);
  assert.equal(equivalentText("Pay 10", "Pay 100"), false);
  assert.equal(equivalentText("I am Ali", "I am All"), false);
});
test("model output cannot contain execution tools or unsupported decisions", () => {
  assert.throws(() => replySchema.parse({ decision: "execute", text: "", reason: "" }));
  assert.throws(() => replySchema.parse({ decision: "reply", text: "Hi", reason: "", tool: "home" }));
});
test("device safety checks reject stale, unsynchronized, active and wrong-device observations", () => {
  const observation = { deviceId: "sf-black-arm-04", frameWidth: 720, frameHeight: 1560, frameSequence: 123456,
    capturedAt: 10000, device: { id: "sf-black-arm-04", connected: true, screen: { source: "iphone-wired-usb-video" },
      state: { grbl: { homed: true, state: "Idle", activeOperation: null }, screenSync: { status: "synchronized", checkedAt: 10000 } } } };
  assert.doesNotThrow(() => assertObservedDevice(observation, 10001));
  assert.throws(() => assertObservedDevice(observation, 13000));
  assert.throws(() => assertObservedDevice({ ...observation, deviceId: "sf-black-arm-05" }, 10001));
  for (const change of [{ activeOperation: "other" }, { homed: false }, { state: "Run" }]) {
    assert.throws(() => assertObservedDevice({ ...observation, device: { ...observation.device, state: { ...observation.device.state,
      grbl: { ...observation.device.state.grbl, ...change } } } }, 10001));
  }
});
