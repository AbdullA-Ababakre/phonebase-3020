import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configurationWithCameraFocus, type FleetCameraConfiguration } from "./camera-selection";
import { appendDiscoveredFleetDevices, assertUniqueFleetHardwareBindings, FleetConfigurationBusyError, updateFleetConfiguration, updateFleetConfigurationSync } from "./fleet-configuration-store";

const devices = [
  { id: "arm-01", serial: "/dev/cu.fake-one", cameraIdentity: "camera-one", profileId: "verified-one", driverPort: 3014, extra: "retained" },
  { id: "arm-02", serial: "/dev/cu.fake-two", cameraIdentity: "camera-two", profileId: "verified-two", driverPort: 3017 },
];
const addition = { id: "arm-03", serial: "/dev/cu.fake-three", cameraIdentity: "camera-three", profileId: "unconfigured", driverPort: 3018 };

test("hardware binding validation rejects duplicate or overlapping controllers, cameras, and listener ports", () => {
  assert.doesNotThrow(() => assertUniqueFleetHardwareBindings(devices));
  assert.throws(() => assertUniqueFleetHardwareBindings([devices[0], { ...devices[1], serial: devices[0].serial }]), /Controller identities overlap/);
  assert.throws(() => assertUniqueFleetHardwareBindings([devices[0], { ...devices[1], serialPrefix: "/dev/cu.fake-" }]), /Controller identities overlap/);
  assert.throws(() => assertUniqueFleetHardwareBindings([devices[0], { ...devices[1], cameraIdentity: "camera-one-prefix" }]), /Camera identities overlap/);
  assert.throws(() => assertUniqueFleetHardwareBindings([devices[0], { ...devices[1], cameraStreamPort: devices[0].driverPort }]), /Duplicate fleet listener port/);
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "phoneuse-fleet-store-"));
  const path = join(directory, "fleet.json");
  writeFileSync(path, JSON.stringify({ devices, videoCapture: { maximumActiveCameras: 4, focusDeviceId: "arm-01", focusedAt: 1 }, stationMetadata: { label: "retain-me" } }));
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  const append = (current: FleetCameraConfiguration) => appendDiscoveredFleetDevices<{ id: string }>(current, devices, current.devices, [addition]);
  return { directory, path, read, append, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("discovery appends to the latest focus/policy while preserving raw existing device fields", async () => {
  const f = fixture();
  try {
    await updateFleetConfiguration(f.path, current => configurationWithCameraFocus(current, "arm-02", ["arm-01", "arm-02"], []));
    updateFleetConfigurationSync(f.path, f.append);
    const stored = f.read();
    assert.equal(stored.videoCapture.maximumActiveCameras, 4);
    assert.equal(stored.videoCapture.focusDeviceId, "arm-02");
    assert.deepEqual(stored.stationMetadata, { label: "retain-me" });
    assert.deepEqual(stored.devices, [...devices, addition]);
  } finally { f.cleanup(); }
});

test("a focus transaction reads the device added since its request began", async () => {
  const f = fixture();
  try {
    updateFleetConfigurationSync(f.path, f.append);
    await updateFleetConfiguration(f.path, current => configurationWithCameraFocus(current, "arm-03", ["arm-01", "arm-02", "arm-03"], []));
    assert.equal(f.read().devices.length, 3);
    assert.equal(f.read().videoCapture.focusDeviceId, "arm-03");
  } finally { f.cleanup(); }
});

test("separate focus and discovery processes cannot clobber one another", async () => {
  const f = fixture();
  const worker = join(f.directory, "worker.mjs");
  const storeUrl = new URL("./fleet-configuration-store.ts", import.meta.url).href;
  const selectionUrl = new URL("./camera-selection.ts", import.meta.url).href;
  writeFileSync(worker, `import {updateFleetConfiguration, appendDiscoveredFleetDevices} from ${JSON.stringify(storeUrl)};
import {configurationWithCameraFocus} from ${JSON.stringify(selectionUrl)};
process.send('ready');
process.once('message', async ({path,role,base,addition}) => {
  try {
    await updateFleetConfiguration(path,current => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80);
      return role==='focus' ? configurationWithCameraFocus(current,'arm-02',['arm-01','arm-02'],[]) : appendDiscoveredFleetDevices(current,base,current.devices,[addition]);
    });
    process.disconnect();
  } catch(e) { process.stderr.write(String(e)); process.exit(1); }
});`);
  const children = ["focus", "discover"].map(role => ({ role, child: spawn(process.execPath, ["--import", "tsx", worker], { stdio: ["ignore", "pipe", "pipe", "ipc"] }) }));
  try {
    await Promise.all(children.map(({ child }) => once(child, "message")));
    const results = children.map(({ child }) => once(child, "exit"));
    for (const { role, child } of children) child.send({ role, path: f.path, base: devices, addition });
    for (const [code] of await Promise.all(results)) assert.equal(code, 0);
    assert.equal(f.read().videoCapture.focusDeviceId, "arm-02");
    assert.equal(f.read().videoCapture.maximumActiveCameras, 4);
    assert.deepEqual(f.read().devices, [...devices, addition]);
  } finally { for (const { child } of children) child.kill(); f.cleanup(); }
});

test("stale discovery cannot overwrite a changed commissioned identity", () => {
  const f = fixture();
  try {
    const current = f.read(); current.devices[0].cameraIdentity = "changed-by-operator";
    writeFileSync(f.path, JSON.stringify(current));
    assert.throws(() => updateFleetConfigurationSync(f.path, f.append), /changed during discovery/);
    assert.deepEqual(f.read(), current);
    assert.equal(readdirSync(f.directory).some(name => name.includes("write-lock") || name.endsWith(".tmp")), false);
  } finally { f.cleanup(); }
});

test("an occupied lock fails closed without deleting its owner or changing config", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.path, "utf8");
    mkdirSync(`${f.path}.write-lock`);
    writeFileSync(`${f.path}.write-lock/owner.json`, JSON.stringify({ pid: process.pid, token: "other-writer" }));
    await assert.rejects(updateFleetConfiguration(f.path, f.append, { timeoutMs: 0 }), FleetConfigurationBusyError);
    assert.equal(readFileSync(f.path, "utf8"), before);
    assert.match(readFileSync(`${f.path}.write-lock/owner.json`, "utf8"), /other-writer/);
  } finally { f.cleanup(); }
});

test("invalid policy or a rejected transform leaves the old document intact and releases the lock", () => {
  const f = fixture();
  try {
    const before = readFileSync(f.path, "utf8");
    assert.throws(() => updateFleetConfigurationSync(f.path, current => ({ ...current, videoCapture: { maximumActiveCameras: 0 } })), /Invalid maximum/);
    assert.throws(() => updateFleetConfigurationSync(f.path, () => { throw new Error("reject"); }), /reject/);
    assert.equal(readFileSync(f.path, "utf8"), before);
    assert.deepEqual(readdirSync(f.directory), ["fleet.json"]);
  } finally { f.cleanup(); }
});
