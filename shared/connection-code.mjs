import { normalizeShortAccessCode, SHORT_CODE_GATEWAY } from "./short-access-code.mjs";
const ACCESS_CODE_PREFIX = "pb_connect_v1.";
const ACCESS_CODE_MAX_LENGTH = 1024;

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error("Phonebase access code is invalid.");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function normalizedAccess(value) {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const url = new URL(String(input.u ?? ""));
  const token = String(input.t ?? "").trim();
  if (
    url.protocol !== "https:" || url.username || url.password ||
    url.search || url.hash || (token.length < 32 && !normalizeShortAccessCode(token)) || token.length > 256
  ) {
    throw new Error("Phonebase access code is invalid.");
  }
  return { gatewayUrl: url.origin, token };
}

export function createPhonebaseAccessCode(gatewayUrl, token) {
  const access = normalizedAccess({ u: gatewayUrl, t: token });
  const payload = encodeBase64Url(JSON.stringify({
    u: access.gatewayUrl,
    t: access.token,
  }));
  return `${ACCESS_CODE_PREFIX}${payload}`;
}

export function readPhonebaseAccessCode(value) {
  const code = String(value ?? "").trim();
  const shortCode = normalizeShortAccessCode(code);
  if (shortCode) return { gatewayUrl: SHORT_CODE_GATEWAY, token: shortCode };
  if (!code.startsWith(ACCESS_CODE_PREFIX) || code.length > ACCESS_CODE_MAX_LENGTH) {
    throw new Error("Phonebase access code is invalid.");
  }
  try {
    return normalizedAccess(JSON.parse(
      decodeBase64Url(code.slice(ACCESS_CODE_PREFIX.length)),
    ));
  } catch {
    throw new Error("Phonebase access code is invalid.");
  }
}
