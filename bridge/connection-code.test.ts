import assert from "node:assert/strict";
import test from "node:test";
import {
  createPhonebaseAccessCode,
  readPhonebaseAccessCode,
} from "../shared/connection-code.mjs";
import { SHORT_CODE_GATEWAY } from "../shared/short-access-code.mjs";

test("combines the gateway and token into one private access code", () => {
  const token = "a".repeat(64);
  const code = createPhonebaseAccessCode("https://station.example/path", token);
  assert.match(code, /^pb_connect_v1\.[a-zA-Z0-9_-]+$/);
  assert.deepEqual(readPhonebaseAccessCode(code), {
    gatewayUrl: "https://station.example",
    token,
  });
});

test("rejects malformed, insecure, and incomplete access codes", () => {
  assert.throws(() => readPhonebaseAccessCode("not-a-code"), /invalid/);
  assert.throws(
    () => createPhonebaseAccessCode("http://station.example", "a".repeat(64)),
    /invalid/,
  );
  assert.throws(
    () => createPhonebaseAccessCode("https://station.example", "too-short"),
    /invalid/,
  );
});


test("short codes normalize grouped input and legacy links still carry an explicit gateway", () => {
  const code = "PB-2345-6789-ABCD-EFGH";
  assert.deepEqual(readPhonebaseAccessCode("pb 2345 6789 abcd efgh"), { gatewayUrl: SHORT_CODE_GATEWAY, token: code });
  const wrapped = createPhonebaseAccessCode("https://another-station.example", code);
  assert.deepEqual(readPhonebaseAccessCode(wrapped), { gatewayUrl: "https://another-station.example", token: code });
  for (const bad of ["PB-2345", "PB-OOOO-OOOO-OOOO-OOOO", "PB-2345-6789-ABCD-EFGH?url=x"]) assert.throws(() => readPhonebaseAccessCode(bad));
});
