// A bare short code belongs to this hosted gateway. Other stations retain their
// self-contained invitation links; no untrusted URL is inferred from user input.
export const SHORT_CODE_GATEWAY = "https://robothand.phonefarm.ai";
export const SHORT_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function normalizeShortAccessCode(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const compact = value.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^PB[2-9A-HJ-NP-Z]{16}$/.test(compact)) return null;
  return "PB-" + compact.slice(2).match(/.{4}/g).join("-");
}
