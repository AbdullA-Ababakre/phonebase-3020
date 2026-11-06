import assert from "node:assert/strict";
import test from "node:test";
import { assertLoopbackControlPlaneListener } from "./control-plane-adoption";

test("control-plane adoption requires only numeric loopback listeners on the expected port", () => {
  assert.doesNotThrow(() => assertLoopbackControlPlaneListener("p123\nf20\nn127.0.0.1:3013\n", 3013));
  assert.doesNotThrow(() => assertLoopbackControlPlaneListener("p123\nf20\nn[::1]:3013\n", 3013));
  for (const record of ["", "n*:3013", "n0.0.0.0:3013", "n127.0.0.1:3014", "n127.0.0.1:3013\nn*:3013"]) {
    assert.throws(() => assertLoopbackControlPlaneListener(record, 3013), /refusing adoption/);
  }
});
