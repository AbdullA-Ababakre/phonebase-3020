import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fleetDiscoverySnapshot, writeFleetDiscoverySnapshot } from "./fleet-discovery-snapshot";

test("diagnostics retain missing configured stations and distinguish components from live video", () => {
  const snapshot = fleetDiscoverySnapshot([
    { id: "arm-01", serial: "/dev/cu.one", cameraIdentity: "camera-one" },
    { id: "arm-02", serial: "/dev/cu.two", cameraIdentity: "camera-two" },
  ], { observedAt: 100, serials: ["/dev/cu.one", "/dev/cu.unknown"], cameras: [{ index: "0", name: "USB Camera2", uniqueId: "camera-one" }, { index: "1", name: "USB Camera2", uniqueId: "camera-unknown" }] }, new Map([["arm-01", "0"]]), true, 200);
  assert.equal(snapshot.observedAt, 100);
  assert.equal(snapshot.publishedAt, 200);
  assert.deepEqual(snapshot.configured[0], { id: "arm-01", controllerPresent: true, cameraResolved: true, reason: null });
  assert.equal(snapshot.configured[1].controllerPresent, false);
  assert.equal(snapshot.configured[1].cameraResolved, false);
  assert.match(snapshot.configured[1].reason!, /not resolved/);
  assert.deepEqual(snapshot.unclaimed, { controllers: ["/dev/cu.unknown"], cameras: [{ identity: "camera-unknown", name: "USB Camera2" }] });
  assert.equal("online" in snapshot.configured[0], false);
});

test("snapshot writes are atomic JSON and preserve observation age", () => {
  const directory = mkdtempSync(join(tmpdir(), "phoneuse-discovery-"));
  try {
    const path = join(directory, "fleet-discovery.json");
    const snapshot = fleetDiscoverySnapshot([], { observedAt: 100, serials: [], cameras: [] }, new Map(), false, 200);
    writeFleetDiscoverySnapshot(path, snapshot);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), snapshot);
    assert.deepEqual(readdirSync(directory), ["fleet-discovery.json"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
