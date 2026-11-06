import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port.");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (value: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, value);
      else child.kill(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) signal("SIGKILL");
}

test("local Dashboard rental API creates, renews, and revokes one-device access", {
  timeout: 30_000,
}, async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "phonebase-rental-admin-"));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  let nodeSocket: WebSocket | null = null;

  try {
    child = spawn(process.execPath, ["--import", "tsx", "agent/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PHONEBASE_CONTROL_PLANE_HOST: "127.0.0.1",
        PHONEBASE_CONTROL_PLANE_PORT: String(port),
        PHONEBASE_ACTION_RECEIPTS_PATH: resolve(temporary, "receipts.json"),
        PHONEBASE_AUDIT_LOG_PATH: resolve(temporary, "audit.jsonl"),
        PHONEBASE_RENTAL_LEASES_PATH: resolve(temporary, "leases.json"),
        PHONEBASE_CALIBRATION_OUTPUT_PATH: resolve(temporary, "calibration.json"),
        PHONEBASE_CALIBRATION_DIRECTORY: "",
        PHONEBASE_REMOTE_PUBLIC_URL: "https://station.example",
        PHONEBASE_REMOTE_ALLOWED_ORIGINS:
          "https://phonebase-cloud-beta.alhazaranwar205.chatgpt.site",
        PHONEBASE_CLOUD_CONSOLE_URL:
          "https://phonebase-cloud-beta.alhazaranwar205.chatgpt.site/console",
        PHONEBASE_REMOTE_TOKEN: "r".repeat(64),
        PHONEBASE_LEASE_SIGNING_SECRET: "s".repeat(64),
      },
      stdio: "ignore",
      detached: process.platform !== "win32",
    });

    let healthy = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await fetch(`${baseUrl}/health`).catch(() => null);
      if (response?.ok) {
        healthy = true;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.equal(healthy, true);

    nodeSocket = new WebSocket(`ws://127.0.0.1:${port}/api/node/socket`);
    await once(nodeSocket, "open");
    nodeSocket.send(JSON.stringify({
      type: "heartbeat",
      deviceId: "black-arm-01",
      state: { cameraReady: true, grbl: { connected: true, state: "Idle" } },
    }));

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const payload = await fetch(`${baseUrl}/api/v1/devices`).then((response) => response.json()) as {
        devices?: Array<{ id?: string }>;
      };
      if (payload.devices?.some((device) => device.id === "black-arm-01")) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }

    // A concurrent retry must share one receipt, including synchronous actions.
    const submitWait = (durationMs: number) => fetch(`${baseUrl}/api/v1/devices/black-arm-01/actions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "retry-wait", action: { type: "wait", durationMs } }),
    });
    const replies = await Promise.all([submitWait(200), submitWait(200)]);
    const waits = await Promise.all(replies.map(r => r.json()));
    assert.equal(waits[0].result.receipt.id, waits[1].result.receipt.id);
    assert.equal(waits[0].result.receipt.status, "completed");
    const conflictWait = await submitWait(201);
    assert.equal(conflictWait.status, 409);
    assert.equal((await conflictWait.json()).code, "IDEMPOTENCY_CONFLICT");
    const waitReceipt = await fetch(`${baseUrl}/api/v1/devices/black-arm-01/actions/${waits[0].result.receipt.id}`).then(r => r.json());
    assert.equal(waitReceipt.receipt.status, "completed");

    const tracedResponse=await fetch(`${baseUrl}/api/v1/devices/black-arm-01/actions`,{
      method:"POST",headers:{"Content-Type":"application/json","X-Phonebase-Client":"mcp","X-Phonebase-Actor":"rental:trace-customer","X-Request-Id":"trace-integration"},
      body:JSON.stringify({idempotencyKey:"trace-status",action:{type:"status"}})});
    assert.equal(tracedResponse.status,200);
    const trace=await fetch(`${baseUrl}/api/v1/admin/observability?requestId=trace-integration`).then(r=>r.json());
    assert.ok(trace.events.some((e:any)=>e.kind==="action.completed" && e.source==="mcp" && e.actor==="rental:trace-customer"));
    assert.ok(trace.events.some((e:any)=>e.kind==="http.request"));
    assert.equal((await fetch(`${baseUrl}/api/v1/admin/observability`,{headers:{Origin:"https://untrusted.example"}})).status,403);
    assert.equal((await fetch(`${baseUrl}/api/v1/admin/observability`,{headers:{"X-Phonebase-Actor":"rental:customer"}})).status,403);
    const telemetry=await fetch(`${baseUrl}/api/v1/devices/black-arm-01/telemetry`,{method:"POST",headers:{"Content-Type":"application/json","X-Phonebase-Actor":"rental:trace-customer"},body:JSON.stringify({kind:"stream.quality",frameAgeMs:1800,samples:20,password:"must-not-store"})});
    assert.equal(telemetry.status,202);
    const monitor=await fetch(`${baseUrl}/api/v1/admin/observability`).then(r=>r.json());
    assert.ok(monitor.incidents.some((i:any)=>i.key.startsWith("client-latency:") && i.resolvedAt===null));
    assert.equal(JSON.stringify(monitor).includes("must-not-store"),false);

    const crossSiteResponse = await fetch(`${baseUrl}/api/v1/admin/rentals`, {
      headers: { Origin: "https://untrusted.example" },
    });
    assert.equal(crossSiteResponse.status, 403);

    const dashboardResponse = await fetch(`${baseUrl}/api/v1/admin/rentals`, {
      headers: { Origin: "http://127.0.0.1:3020" },
    });
    assert.equal(dashboardResponse.status, 200);

    const createdResponse = await fetch(`${baseUrl}/api/v1/admin/rentals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "black-arm-01",
        customer: "friend@example.com",
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      lease: { id: string; status: string; accessCode: string; expiresAt: string };
    };
    assert.equal(created.lease.status, "active");
    assert.match(created.lease.accessCode, /^pb_connect_v1\./);

    // Reusing a physical device after a prior customer must not expose that customer's receipt.
    const priorAction = await fetch(`${baseUrl}/api/v1/devices/black-arm-01/actions`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Phonebase-Actor": "rental:previous-customer" },
      body: JSON.stringify({ idempotencyKey: "shared-step-name", action: { type: "hold" } }),
    });
    assert.equal(priorAction.status, 202);
    const collision = await fetch(`${baseUrl}/api/v1/devices/black-arm-01/actions`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Phonebase-Actor": `rental:${created.lease.id}` },
      body: JSON.stringify({ idempotencyKey: "shared-step-name", action: { type: "hold" } }),
    });
    assert.equal(collision.status, 409);
    assert.equal((await collision.text()).includes("previous-customer"), false);

    const duplicateResponse = await fetch(`${baseUrl}/api/v1/admin/rentals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "black-arm-01",
        customer: "another@example.com",
      }),
    });
    assert.equal(duplicateResponse.status, 400);

    const renewedResponse = await fetch(
      `${baseUrl}/api/v1/admin/rentals/${encodeURIComponent(created.lease.id)}/renew`,
      { method: "POST" },
    );
    assert.equal(renewedResponse.status, 200);
    const renewed = await renewedResponse.json() as {
      lease: { accessCode: string; expiresAt: string };
    };
    assert.match(renewed.lease.accessCode, /^pb_connect_v1\./);
    assert.equal(renewed.lease.accessCode, created.lease.accessCode);
    assert.ok(Date.parse(renewed.lease.expiresAt) > Date.parse(created.lease.expiresAt));

    const revokedResponse = await fetch(
      `${baseUrl}/api/v1/admin/rentals/${encodeURIComponent(created.lease.id)}/revoke`,
      { method: "POST" },
    );
    assert.equal(revokedResponse.status, 200);

    const listResponse = await fetch(`${baseUrl}/api/v1/admin/rentals`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as {
      configured: boolean;
      leases: Array<{ id: string; status: string; accessCode: string | null }>;
    };
    assert.equal(list.configured, true);
    assert.deepEqual(list.leases.map((lease) => ({
      id: lease.id,
      status: lease.status,
      accessCode: lease.accessCode,
    })), [{ id: created.lease.id, status: "revoked", accessCode: null }]);
  } finally {
    nodeSocket?.close();
    if (child) await stopChild(child);
    await rm(temporary, { recursive: true, force: true });
  }
});
