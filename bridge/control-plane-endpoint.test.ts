import assert from "node:assert/strict";
import test from "node:test";
import { createPhonebaseAccessCode } from "../shared/connection-code.mjs";
import {
  normalizedRemoteEndpoint,
  resolveControlPlaneEndpoint,
  rememberRemoteEndpoint,
  remoteEndpointFromAccessCode,
} from "../app/control-plane-endpoint";

test("existing shared links migrate to the fixed gateway without replacing their lease", () => {
  const token = "lease-test-".repeat(6);
  for (const old of [
    "https://phonebase-station.videocoding.ai",
    "https://morris-liquid-cho-panel.trycloudflare.com",
    "https://review-homes-joel-perspectives.trycloudflare.com",
  ]) {
    const code = createPhonebaseAccessCode(old, token);
    const expected = { baseUrl: "https://gateway.phonebase.co", accessToken: token, remote: true };
    assert.deepEqual(remoteEndpointFromAccessCode(code), expected);
    assert.deepEqual(remoteEndpointFromAccessCode(`https://console.example/console#access=${code}`), expected);
    // Existing tab pairings also pass through this normalization on reload.
    assert.deepEqual(normalizedRemoteEndpoint(old, token), expected);
  }
});

test("gateway migration is exact and retains endpoint validation", () => {
  const token = "a".repeat(64);
  for (const origin of [
    "https://another-station.example",
    "https://morris-liquid-cho-panel.trycloudflare.com.attacker.example",
    "https://review-homes-joel-perspectives.trycloudflare.com:8443",
  ]) assert.equal(normalizedRemoteEndpoint(origin, token)?.baseUrl, origin);
  assert.equal(normalizedRemoteEndpoint("https://user:password@morris-liquid-cho-panel.trycloudflare.com", token), null);
  assert.equal(normalizedRemoteEndpoint("https://morris-liquid-cho-panel.trycloudflare.com?target=https://attacker.example", token), null);
  assert.equal(normalizedRemoteEndpoint("http://morris-liquid-cho-panel.trycloudflare.com", token), null);
  assert.equal(normalizedRemoteEndpoint("https://morris-liquid-cho-panel.trycloudflare.com", "short"), null);
});


test("customer console requires an invitation on localhost and preserves helper handoff", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { hostname: "127.0.0.1", hash: "", pathname: "/console", search: "" },
    history: { state: null, replaceState() {} },
    sessionStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) },
  } });
  try {
    assert.equal(resolveControlPlaneEndpoint().endpoint?.remote, false);
    assert.deepEqual(resolveControlPlaneEndpoint({ remoteOnly: true }), { endpoint: null, error: "" });
    const endpoint = { baseUrl: "https://station.example", accessToken: "test-invitation-".repeat(4), remote: true };
    rememberRemoteEndpoint(endpoint);
    assert.deepEqual(resolveControlPlaneEndpoint({ remoteOnly: true }).endpoint, endpoint);
    window.location.hash = "#access=incomplete-invitation";
    const invalid = resolveControlPlaneEndpoint({ remoteOnly: true });
    assert.equal(invalid.endpoint, null);
    assert.match(invalid.error, /invalid or incomplete/);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
