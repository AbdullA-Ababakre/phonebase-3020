import assert from "node:assert/strict";
import test from "node:test";
import { PhysicalCommandLock } from "./physical_command_lock";

test("physical command lock admits one writer and fails concurrent commands closed", () => {
  const lock = new PhysicalCommandLock();
  assert.equal(lock.acquire("first"), true);
  assert.equal(lock.busy, true);
  assert.equal(lock.acquire("second"), false);
  assert.equal(lock.busy, true);
});

test("only the owning command can release the physical command lock", () => {
  const lock = new PhysicalCommandLock();
  assert.equal(lock.acquire("owner"), true);
  assert.equal(lock.release("different"), false);
  assert.equal(lock.acquire("next"), false);
  assert.equal(lock.release("owner"), true);
  assert.equal(lock.acquire("next"), true);
});
