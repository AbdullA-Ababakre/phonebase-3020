import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

test("hardware discovery is local-only and never advertises diagnostic entries as online devices", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "phoneuse-discovery-api-"));
  const reservation = createServer();
  await new Promise<void>(done => reservation.listen(0, "127.0.0.1", done));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(done => reservation.close(() => done()));
  const token = "isolated-discovery-test-token";
  const headers = { authorization: `Bearer ${token}`, origin: "http://127.0.0.1:3020" };
  const snapshotPath = resolve(directory, "discovery.json");
  let child: ChildProcess | null = null;
  try {
    await writeFile(snapshotPath, JSON.stringify({ version: 1, observedAt: Date.now(), publishedAt: Date.now(), discoveryPending: true,
      configured: [{ id: "isolated-stand", controllerPresent: true, cameraResolved: false, reason: "Camera identity is unresolved" }],
      unclaimed: { controllers: [], cameras: [{ identity: "0x1100000bda5858", name: "USB Camera2" }] } }));
    await writeFile(resolve(directory, "fleet.json"), JSON.stringify({ devices: [] }));
    child = spawn(process.execPath, ["--import", resolve(import.meta.dirname, "../node_modules/tsx/dist/loader.mjs"), resolve(import.meta.dirname, "server.ts")], {
      cwd: directory, stdio: "ignore", env: {
        ...process.env, PHONEBASE_CONTROL_PLANE_HOST: "127.0.0.1", PHONEBASE_CONTROL_PLANE_PORT: String(port),
        PHONEBASE_CONTROL_PLANE_ALLOW_REMOTE: "0", PHONEBASE_CONTROL_PLANE_TOKEN: token,
        PHONEBASE_ACTION_RECEIPTS_PATH: resolve(directory, "receipts.json"), PHONEBASE_AUDIT_LOG_PATH: resolve(directory, "audit.jsonl"),
        PHONEBASE_OBSERVABILITY_PATH: resolve(directory, "observability.sqlite"), PHONEBASE_RENTAL_LEASES_PATH: resolve(directory, "leases.json"),
        PHONEBASE_RECORDER_PATH: resolve(directory, "recorder.json"), PHONEBASE_OPENROUTER_KEY_PATH: resolve(directory, "no-key"),
        PHONEBASE_CALIBRATION_PATH: resolve(directory, "no-profile.json"), PHONEBASE_CALIBRATION_OUTPUT_PATH: resolve(directory, "calibration.json"),
        PHONEBASE_CALIBRATION_DIRECTORY: resolve(directory, "calibrations"), PHONEBASE_CALIBRATION_DRAFTS_PATH: resolve(directory, "drafts.json"),
        PHONEBASE_PUBLISHING_DIR: resolve(directory, "publishing"), PHONEBASE_FLEET_CONFIG: resolve(directory, "fleet.json"),
        PHONEBASE_FLEET_DISCOVERY_PATH: snapshotPath, PHONEBASE_REMOTE_PUBLIC_URL: "https://station.invalid",
        PHONEBASE_REMOTE_TOKEN: "r".repeat(64), PHONEBASE_LEASE_SIGNING_SECRET: "s".repeat(64),
        PHONEBASE_CLOUD_CONSOLE_URL: "https://console.invalid", OPENROUTER_API_KEY: "", OPENAI_API_KEY: "",
      },
    });
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error("Isolated discovery server exited");
      if ((await fetch(`${base}/health`, { headers }).catch(() => null))?.ok) { healthy = true; break; }
      await pause(100);
    }
    assert.ok(healthy);
    const url = `${base}/api/v1/admin/fleet-discovery`;
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.discovery.available, true);
    assert.equal(body.discovery.configured[0].controllerPresent, true);
    assert.equal(body.discovery.configured[0].nodeConnected, false);
    assert.equal(body.discovery.configured[0].liveVideo, false);
    assert.equal((await (await fetch(`${base}/api/v1/devices`, { headers })).json()).devices.length, 0);
    const rejectedHeaders: Record<string, string>[] = [{ origin: "https://customer.invalid" }, { "x-forwarded-for": "192.0.2.1" },
      { forwarded: "for=192.0.2.1" }, { "x-phonebase-actor": "rental:example" }];
    for (const extra of rejectedHeaders) {
      assert.equal((await fetch(url, { headers: { ...headers, ...extra } })).status, 403);
    }
    await writeFile(snapshotPath, "invalid-json");
    const invalid = await (await fetch(url, { headers })).json();
    assert.equal(invalid.discovery.available, false);
    assert.deepEqual(invalid.discovery.configured, []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM");
      await Promise.race([exited, pause(1_000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
