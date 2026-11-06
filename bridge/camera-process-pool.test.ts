import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CameraProcessPool, type CameraProcessSpec } from "./camera-process-pool";

class Capture extends EventEmitter {
  stops = 0;
  kill() { this.stops++; return true; }
}
const spec = (id: string, signature = id): CameraProcessSpec => ({ id, signature, command: "capture", args: [id] });
function fixture() {
  let now = 100;
  const launched: Array<{ id: string; process: Capture }> = [];
  const pool = new CameraProcessPool(input => {
    const process = new Capture(); launched.push({ id: input.id, process }); return process;
  }, () => now);
  return { pool, launched, advance: (ms: number) => { now += ms; } };
}
test("adding, removing, or reconfiguring a camera preserves healthy captures", () => {
  const f = fixture(); f.pool.reconcile([spec("04")]);
  const first = f.launched[0].process;
  f.pool.reconcile([spec("04"), spec("05")]);
  assert.equal(first.stops, 0); assert.equal(f.launched.length, 2);
  f.pool.reconcile([spec("04"), spec("05", "new-format")]);
  assert.equal(first.stops, 0); assert.equal(f.launched[1].process.stops, 1);
  f.pool.reconcile([spec("04")]);
  assert.equal(first.stops, 0); assert.equal(f.launched[2].process.stops, 1);
});
test("a crash restarts only the failed camera with bounded backoff", () => {
  const f = fixture(); const desired = [spec("04"), spec("05")];
  f.pool.reconcile(desired); f.launched[1].process.emit("exit", 75);
  f.pool.reconcile(desired); assert.equal(f.launched.length, 2);
  f.advance(1000); f.pool.reconcile(desired);
  assert.equal(f.launched.length, 3); assert.equal(f.launched[2].id, "05");
  assert.equal(f.launched[0].process.stops, 0);
  // An old process's later error/exit must not remove its replacement.
  f.launched[1].process.emit("error", new Error("late error"));
  f.pool.reconcile(desired); assert.equal(f.launched.length, 3);
});
test("shutdown and removed cameras never leave restart candidates", () => {
  const f = fixture(); f.pool.reconcile([spec("04"), spec("05")]);
  f.launched[1].process.emit("error", new Error("failed to launch"));
  f.pool.reconcile([spec("04")]); f.advance(10000); f.pool.reconcile([spec("04")]);
  assert.equal(f.launched.length, 2);
  f.pool.stop(); assert.equal(f.launched[0].process.stops, 1);
});
test("duplicate identities are rejected before stopping a healthy capture", () => {
  const f = fixture(); f.pool.reconcile([spec("04")]);
  assert.throws(() => f.pool.reconcile([spec("04"), spec("04")]), /Duplicate/);
  assert.equal(f.launched[0].process.stops, 0);
});

test("staggered startup avoids opening every USB stream at once", () => {
  let now = 0;
  const launched: string[] = [];
  const pool = new CameraProcessPool(input => { launched.push(input.id); return new Capture(); }, () => now, 3000);
  const desired = [spec("04"), spec("05"), spec("06")];
  pool.reconcile(desired); assert.deepEqual(launched, ["04"]);
  now = 2999; pool.reconcile(desired); assert.deepEqual(launched, ["04"]);
  now = 3000; pool.reconcile(desired); assert.deepEqual(launched, ["04", "05"]);
  now = 6000; pool.reconcile(desired); assert.deepEqual(launched, ["04", "05", "06"]);
});
