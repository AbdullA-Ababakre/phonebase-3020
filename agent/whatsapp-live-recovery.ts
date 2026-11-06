import { sameChatName } from "./whatsapp-navigation";

/** Retries are released by a fresh live frame, never by a message polling timer. */
export class FrameRetryGate {
  attempts = 0;
  retryAt = 0;
  lastError = "";

  fail(error: string, at = Date.now()) {
    this.attempts++;
    this.lastError = error;
    this.retryAt = at + Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts - 1, 5));
  }

  ready(at = Date.now()) { return !this.retryAt || at >= this.retryAt; }
  get pending() { return this.attempts > 0; }
  succeed() { this.attempts = 0; this.retryAt = 0; this.lastError = ""; }
}

export function chatHasUnresolvedSend(entries: Array<{ chat: string; status: string }>, chat: string) {
  return entries.some(entry => sameChatName(entry.chat, chat) &&
    ["drafting", "pending_send", "uncertain"].includes(entry.status));
}

export function transientPreview(preview: string) {
  return /^(?:typing(?:\.{3}|…)?|recording audio(?:\.{3}|…)?|.+ is typing(?:\.{3}|…)?)$/i.test(preview.trim());
}
