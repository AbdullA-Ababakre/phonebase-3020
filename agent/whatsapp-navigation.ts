import { createHash } from "node:crypto";
import type { VisionOcrResult } from "./vision-ocr";

// Verified on arm 04, in WhatsApp only, both with and without the keyboard.
// The visible arrow's outer edge and the generic iOS edge swipe miss this target.
export const WHATSAPP_BACK = Object.freeze({ x: 66, y: 140 });
export const WHATSAPP_DEVICE = "sf-black-arm-04";
export const WHATSAPP_GROUP = "Phoneuse - aun.ai";
export const WHATSAPP_TOUCH_Z = 9.825;
export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
export const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
export function sameChatName(left: string, right: string) {
  const a = normalize(left), b = normalize(right);
  const phone = (s: string) => /^\+?[\d ()\-]+$/.test(s) && s.replace(/\D/g, "").length >= 7;
  return a === b || (phone(a) && phone(b) && a.replace(/\D/g, "") === b.replace(/\D/g, ""));
}

export function requireWhatsAppViewport(ocr: VisionOcrResult) {
  if (ocr.imageWidth !== 720 || ocr.imageHeight !== 1560) throw Error("Unverified WhatsApp viewport");
}

export function isWhatsAppInbox(ocr: VisionOcrResult) {
  requireWhatsAppViewport(ocr);
  const has = (text: string, low: number, high: number) => ocr.items.some(i =>
    normalize(i.text) === text && i.confidence >= 0.7 && i.centerY > low && i.centerY < high);
  // iOS expands the title after the list settles; the compact and large-title
  // layouts are the same inbox, but their chat rows have different y positions.
  return has("Chats", 90, 270) &&
    ["Updates", "Calls", "Communities", "Chats", "You"].filter(text => has(text, 1400, 1510)).length >= 2;
}

export function chatHeaderMatches(ocr: VisionOcrResult, name: string) {
  requireWhatsAppViewport(ocr);
  return !isWhatsAppInbox(ocr) && ocr.items.some(i => i.confidence >= 0.7 &&
    i.centerY > 90 && i.centerY < 151 && i.left > 175 && sameChatName(i.text, name));
}

export type InboxRow = { name: string; point: { x: number; y: number }; fingerprint: string; preview: string };

export function inboxRows(ocr: VisionOcrResult): InboxRow[] {
  if (!isWhatsAppInbox(ocr)) return [];
  // A title must share a line with its right-aligned message time. A name in
  // the preview ("Hello Sultan") is never an eligible navigation target.
  const times = ocr.items.filter(i => i.confidence >= 0.65 && i.left > 540 &&
    i.centerY > 260 && i.centerY < 1380 && /^(\d{1,2}:\d{2}(?:\s*[AP]M)?|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i.test(i.text.trim()))
    .sort((a, b) => a.centerY - b.centerY);
  return times.flatMap((time, index) => {
    const candidates = ocr.items.filter(i => i.confidence >= 0.7 && i.left >= 140 && i.left < 400 &&
      Math.abs(i.centerY - time.centerY) < 15);
    if (candidates.length !== 1 || candidates[0].text.includes("…")) return [];
    const title = candidates[0];
    const end = Math.min(time.centerY + 105, (times[index + 1]?.centerY ?? 1490) - 30);
    const preview = ocr.items.filter(i => i.left >= 145 && i.centerY > time.centerY + 18 && i.centerY < end)
      .sort((a, b) => a.top - b.top).map(i => normalize(i.text)).join(" ");
    return [{ name: normalize(title.text), preview, point: { x: 240, y: Math.round(title.centerY) },
      fingerprint: fingerprint(`${normalize(title.text)}|${time.text}|${preview}`) }];
  });
}

export function locateInboxChat(ocr: VisionOcrResult, name: string) {
  const rows = inboxRows(ocr).filter(row => sameChatName(row.name, name));
  if (rows.length !== 1) throw Error("Chat title not uniquely visible in the inbox");
  return rows[0].point;
}

export function stableInboxTarget(before: VisionOcrResult, after: VisionOcrResult, name: string) {
  const a = locateInboxChat(before, name), b = locateInboxChat(after, name);
  if (Math.hypot(a.x - b.x, a.y - b.y) > 3) return null;
  return b;
}

export function sameInboxLayout(before: VisionOcrResult, after: VisionOcrResult) {
  if (!isWhatsAppInbox(before) || !isWhatsAppInbox(after)) return false;
  const a = inboxRows(before), b = inboxRows(after);
  return a.length === b.length && a.every((row, i) => sameChatName(row.name, b[i].name) &&
    row.fingerprint === b[i].fingerprint && Math.abs(row.point.y - b[i].point.y) <= 3);
}

export function assertObservedDevice(observation: any, now = Date.now()) {
  const d = observation?.device, s = d?.state, grbl = s?.grbl;
  if (observation?.deviceId !== WHATSAPP_DEVICE || d?.id !== WHATSAPP_DEVICE || !d?.connected ||
    observation.frameWidth !== 720 || observation.frameHeight !== 1560 ||
    !Number.isSafeInteger(observation.frameSequence) || now - observation.capturedAt > 2000 ||
    now < observation.capturedAt || !grbl?.homed || grbl?.state !== "Idle" || grbl?.activeOperation ||
    s?.screenSync?.status !== "synchronized" || now - s.screenSync.checkedAt > 5000 ||
    !String(d.screen?.source).includes("iphone-wired")) {
    throw Error("Device busy, stale, unsynchronized, disconnected, or outside verified setup");
  }
}
