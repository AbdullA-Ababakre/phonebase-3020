import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { CalibrationDraftStore, parseCalibrationDrafts, type CalibrationDraft } from "./calibration-draft-store";

const draft = (deviceId = "test-device-a"): CalibrationDraft => ({
  deviceId, frame: { width: 720, height: 1280, sequence: 12345 },
  screen: { width: 720, height: 1560 },
  imagePoints: [{ x: 100, y: 100 }, { x: 600, y: 100 }, null, null],
  machinePoints: [{ x: 1, y: 2 }, { x: 60, y: 2 }, null, null],
  startedAt: "2026-11-03T12:00:00.000Z",
});
const snapshot = (value = draft()) => ({ version: 1, drafts: { [value.deviceId]: value } });

test("draft store round-trips two independent devices and removes only the selected draft", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "phoneuse-drafts-"));
  try {
    const path = resolve(temporary, "drafts.json");
    const store = new CalibrationDraftStore(path);
    assert.equal((await store.load()).size, 0);
    const first = draft(), second = draft("test-device-b");
    const entries = new Map([[first.deviceId, first], [second.deviceId, second]]);
    await store.save(entries);
    const restored = await new CalibrationDraftStore(path).load();
    assert.deepEqual([...restored], [...entries]);
    restored.delete(first.deviceId); await store.save(restored);
    assert.deepEqual([...(await store.load())], [[second.deviceId, second]]);
    assert.deepEqual(await readdir(temporary), ["drafts.json"]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("draft parsing rejects bad versions, cross-device identities, and active profiles", () => {
  assert.throws(() => parseCalibrationDrafts({ version: 2, drafts: {} }), /version/);
  assert.throws(() => parseCalibrationDrafts({ version: 1, drafts: [] }), /entries/);
  assert.throws(() => parseCalibrationDrafts({ version: 1, drafts: { wrong: draft() } }), /exactly match/);
  assert.throws(() => parseCalibrationDrafts({ version: 1, drafts: { "test-device-a": { ...draft(), verified: true } } }), /active profile/);
});

test("draft parsing rejects malformed dimensions, coordinates, point counts, and dates", () => {
  for (const mutate of [
    (value: CalibrationDraft) => { value.frame.width = 0; },
    (value: CalibrationDraft) => { value.frame.sequence = NaN; },
    (value: CalibrationDraft) => { value.screen.height = 200; },
    (value: CalibrationDraft) => { value.imagePoints = [null]; },
    (value: CalibrationDraft) => { value.imagePoints[0] = { x: 721, y: 0 }; },
    (value: CalibrationDraft) => { value.imagePoints[0] = { x: 0, y: -1 }; },
    (value: CalibrationDraft) => { value.machinePoints[0] = { x: Infinity, y: 0 }; },
    (value: CalibrationDraft) => { value.startedAt = "not-a-date"; },
  ]) {
    const value = draft(); mutate(value);
    assert.throws(() => parseCalibrationDrafts(snapshot(value)), /Invalid calibration draft/);
  }
});

test("malformed saved drafts fail without overwriting or deleting their file", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "phoneuse-drafts-invalid-"));
  try {
    const path = resolve(temporary, "drafts.json");
    await writeFile(path, "{broken");
    await assert.rejects(new CalibrationDraftStore(path).load(), /saved file was preserved/);
    assert.equal(await readFile(path, "utf8"), "{broken");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("queued writes use immutable snapshots and never overlap", async () => {
  const writes: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const store = new CalibrationDraftStore("not-a-real-path", async (_path, body) => {
    writes.push(body);
    if (writes.length === 1) await gate;
  });
  const value = draft();
  const entries = new Map([[value.deviceId, value]]);
  const first = store.save(entries);
  value.imagePoints[0] = { x: 110, y: 110 };
  const second = store.save(entries);
  await Promise.resolve();
  assert.equal(writes.length, 1);
  release(); await Promise.all([first, second]);
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[0]).drafts[value.deviceId].imagePoints[0].x, 100);
  assert.equal(JSON.parse(writes[1]).drafts[value.deviceId].imagePoints[0].x, 110);
});

test("a failed durable write rejects its caller and does not poison later saves", async () => {
  let attempts = 0;
  const store = new CalibrationDraftStore("not-a-real-path", async () => {
    if (++attempts === 1) throw new Error("test disk failure");
  });
  const entries = new Map([["test-device-a", draft()]]);
  await assert.rejects(store.save(entries), /test disk failure/);
  await store.save(entries);
  assert.equal(attempts, 2);
});
