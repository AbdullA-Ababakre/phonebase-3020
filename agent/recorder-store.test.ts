import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { RecorderStore, recordedAction } from "./recorder-store";

test("normalizes recorded coordinates and excludes safety controls", () => {
  assert.deepEqual(recordedAction({
    type: "tap",
    point: { x: 360, y: 390 },
    viewport: { width: 720, height: 1560 },
    frameSequence: 42,
    durationMs: 40,
  }), {
    type: "tap",
    point: { x: 0.5, y: 0.25 },
    durationMs: 40,
  });
  assert.equal(recordedAction({ type: "hold" }), null);
  assert.equal(recordedAction({ type: "home", confirmation: "CLEAR_WORKSPACE_AND_HOME" }), null);
});

test("persists a recording as a replayable workflow", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "phonebase-recorder-"));
  const path = resolve(temporary, "recorder.json");
  try {
    const store = new RecorderStore(path);
    await store.load();
    const session = await store.start("arm-1", "Open Weather");
    await store.record("arm-1", {
      type: "phone_key",
      key: "home",
    }, "receipt-1");
    await store.record("arm-1", {
      type: "tap",
      point: { x: 100, y: 200 },
      viewport: { width: 200, height: 400 },
      frameSequence: 9,
      durationMs: 40,
    }, "receipt-2");
    const workflow = await store.stop(session.id);
    assert.equal(workflow.steps.length, 2);
    assert.deepEqual(workflow.steps[1].action, {
      type: "tap",
      point: { x: 0.5, y: 0.5 },
      durationMs: 40,
    });
    const restored = new RecorderStore(path);
    await restored.load();
    assert.equal(restored.snapshot().workflows[0].name, "Open Weather");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
