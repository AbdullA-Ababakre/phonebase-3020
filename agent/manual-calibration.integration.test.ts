import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { WebSocket } from "ws";

const pause = (ms: number) => new Promise<void>(resolveWait => setTimeout(resolveWait, ms));
type Command = { id: string; action: string; params: { x: number; y: number; mode: string } };

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, pause(1_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL"); await exited;
  }
}

async function fakeNode(baseUrl: string, token: string, deviceId: string) {
  const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/node/socket`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const state = {
    appVersion: "0.1.14", cameraReady: true,
    grbl: {
      connected: true, homed: true, state: "Idle", calibrationActive: true,
      x: 1, y: 2, z: 0, activeOperation: null,
      lastOperation: {} as Record<string, unknown>,
      movementBounds: { minimumX: 1, maximumX: 80, minimumY: 1, maximumY: 170 },
      calibrationMovementBounds: { minimumX: 1, maximumX: 82, minimumY: 1, maximumY: 170 },
      tapProfile: { id: "unconfigured", hoverZ: 1, touchZ: 10 },
    },
  };
  const commands: Command[] = [];
  const receivedCommands: Command[] = [];
  const commandWaiters: Array<(command: Command) => void> = [];
  const ackWaiters: Array<() => void> = [];
  socket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === "heartbeat_ack") ackWaiters.splice(0).forEach(resolveAck => resolveAck());
    if (message.type === "command") {
      commands.push(message);
      const waiting = commandWaiters.shift();
      if (waiting) waiting(message); else receivedCommands.push(message);
    }
  });
  await once(socket, "open");
  const sendHeartbeat = () => socket.send(JSON.stringify({ type: "heartbeat", deviceId, state }));
  const heartbeat = async () => {
    const ack = new Promise<void>(resolveAck => ackWaiters.push(resolveAck));
    sendHeartbeat();
    await Promise.race([ack, pause(2_000).then(() => { throw new Error("Fake node heartbeat was not acknowledged."); })]);
  };
  let timer: ReturnType<typeof setInterval> | null = setInterval(sendHeartbeat, 500);
  await heartbeat();
  return {
    socket, state, commands, heartbeat,
    nextCommand: () => receivedCommands.length
      ? Promise.resolve(receivedCommands.shift()!)
      : new Promise<Command>(resolveCommand => commandWaiters.push(resolveCommand)),
    commandResult: (id: string, ok: boolean, error?: string) => socket.send(JSON.stringify({
      type: "event", deviceId, name: "command-result", payload: { id, ok, ...(error ? { error } : {}) },
    })),
    keepAliveWithoutStatus: () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => socket.send(JSON.stringify({ type: "event", deviceId, name: "test-alive", payload: {} })), 100);
    },
    resumeHeartbeat: () => { if (timer) clearInterval(timer); timer = setInterval(sendHeartbeat, 500); },
    close: () => { if (timer) clearInterval(timer); socket.terminate(); },
  };
}

test("isolated manual calibration API uses fresh device evidence and final jog outcomes", { timeout: 45_000 }, async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), "phoneuse-calibration-api-"));
  const port = await reservePort();
  assert.ok(![3013, 3014, 3015, 3016, 3020, 3031].includes(port));
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = "isolated-calibration-test-token";
  const serverPath = resolve(import.meta.dirname, "server.ts");
  const loaderPath = resolve(import.meta.dirname, "../node_modules/tsx/dist/loader.mjs");
  let child: ChildProcess | null = null;
  let first: Awaited<ReturnType<typeof fakeNode>> | null = null;
  let second: Awaited<ReturnType<typeof fakeNode>> | null = null;
  const firstId = "calibration-test-a", secondId = "calibration-test-b";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (deviceId: string, body: unknown) => {
    const response = await fetch(`${baseUrl}/api/v1/devices/${deviceId}/calibration`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: await response.json() };
  };
  const upload = async (deviceId: string, capturedAt = Date.now(), width = 720, height = 1280) => {
    const jpeg = await sharp({ create: { width, height, channels: 3, background: "#eeeeee" } }).jpeg().toBuffer();
    const response = await fetch(`${baseUrl}/api/frame/jpeg`, {
      method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "image/jpeg",
        "x-phonebase-device-id": deviceId, "x-phonebase-frame-width": String(width),
        "x-phonebase-frame-height": String(height), "x-phonebase-captured-at": String(capturedAt),
        "x-phonebase-frame-source": "black-arm-built-in-uvc", "x-phonebase-frame-role": "verification",
      }, body: new Uint8Array(jpeg),
    });
    assert.equal(response.status, 200);
  };
  try {
    // Only the control-plane source runs. Every database, workflow, secret path,
    // fleet config, and working directory belongs to this empty test directory.
    // There is no physical driver, supervisor, gateway, or production node.
    const launchServer = () => spawn(process.execPath, ["--import", loaderPath, serverPath], {
      cwd: temporary, stdio: "ignore",
      env: {
        ...process.env,
        PHONEBASE_CONTROL_PLANE_HOST: "127.0.0.1", PHONEBASE_CONTROL_PLANE_PORT: String(port),
        PHONEBASE_CONTROL_PLANE_ALLOW_REMOTE: "0", PHONEBASE_CONTROL_PLANE_TOKEN: token,
        PHONEBASE_ACTION_RECEIPTS_PATH: resolve(temporary, "receipts.json"),
        PHONEBASE_AUDIT_LOG_PATH: resolve(temporary, "audit.jsonl"),
        PHONEBASE_OBSERVABILITY_PATH: resolve(temporary, "observability.sqlite"),
        PHONEBASE_RENTAL_LEASES_PATH: resolve(temporary, "leases.json"),
        PHONEBASE_RECORDER_PATH: resolve(temporary, "recorder.json"),
        PHONEBASE_OPENROUTER_KEY_PATH: resolve(temporary, "no-key"),
        PHONEBASE_CALIBRATION_PATH: resolve(temporary, "no-profile.json"),
        PHONEBASE_CALIBRATION_OUTPUT_PATH: resolve(temporary, "calibration.json"),
        PHONEBASE_CALIBRATION_DIRECTORY: resolve(temporary, "calibrations"),
        PHONEBASE_CALIBRATION_DRAFTS_PATH: resolve(temporary, "drafts.json"),
        PHONEBASE_PUBLISHING_DIR: resolve(temporary, "publishing"),
        PHONEBASE_FLEET_CONFIG: resolve(temporary, "fleet.json"),
        PHONEBASE_REMOTE_PUBLIC_URL: "https://station.invalid", PHONEBASE_REMOTE_TOKEN: "r".repeat(64),
        PHONEBASE_LEASE_SIGNING_SECRET: "s".repeat(64),
        PHONEBASE_CLOUD_CONSOLE_URL: "https://console.invalid", OPENROUTER_API_KEY: "", OPENAI_API_KEY: "",
      },
    });
    const waitHealthy = async () => {
      let healthy = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        if (child?.exitCode !== null) throw new Error("Isolated calibration server exited during startup.");
        const health = await fetch(`${baseUrl}/health`, { headers }).catch(() => null);
        if (health?.ok) { healthy = true; break; }
        await pause(100);
      }
      assert.equal(healthy, true, "Isolated test server starts on its reserved port.");
    };
    child = launchServer();
    await waitHealthy();
    first = await fakeNode(baseUrl, token, firstId);
    second = await fakeNode(baseUrl, token, secondId);
    const a = first, b = second;

    await t.test("begin and image capture stay with their device's physical frame", async () => {
      assert.equal((await post(firstId, { operation: "begin" })).body.code, "FRAME_UNAVAILABLE");
      await upload(firstId);
      assert.equal((await post(secondId, { operation: "begin" })).body.code, "FRAME_UNAVAILABLE");
      const began = await post(firstId, { operation: "begin", screenWidth: 720, screenHeight: 1560 });
      assert.equal(began.status, 200); assert.equal(began.body.calibration.draft.deviceId, firstId);
      const image = await post(firstId, { operation: "capture_image_point", index: 0, x: 100, y: 100 });
      assert.equal(image.status, 200); assert.deepEqual(image.body.calibration.draft.imagePoints[0], { x: 100, y: 100 });
      await upload(secondId);
      assert.equal((await post(secondId, { operation: "begin" })).status, 200);
      assert.equal((await post(secondId, { operation: "capture_image_point", index: 0, x: 120, y: 120 })).status, 200);
    });

    await t.test("unhomed movement and capture fail before dispatch", async () => {
      a.state.grbl.homed = false; await a.heartbeat(); await upload(firstId);
      for (const operation of [
        { operation: "jog", axis: "X", distance: 2 },
        { operation: "capture_machine_point", index: 0 },
      ]) {
        const result = await post(firstId, operation);
        assert.equal(result.status, 409); assert.equal(result.body.code, "MACHINE_HOME_REQUIRED");
      }
      assert.equal(a.commands.length, 0);
      a.state.grbl.homed = true; await a.heartbeat();
    });

    await t.test("machine captures need a matching corner and distinct XY", async () => {
      await upload(firstId);
      assert.equal((await post(firstId, { operation: "capture_machine_point", index: 1 })).body.code, "CAMERA_POINT_REQUIRED");
      const captured = await post(firstId, { operation: "capture_machine_point", index: 0 });
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.body.calibration.draft.machinePoints[0], { x: 1, y: 2 });
      await post(firstId, { operation: "capture_image_point", index: 1, x: 600, y: 100 });
      const duplicate = await post(firstId, { operation: "capture_machine_point", index: 1 });
      assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, "DUPLICATE_MACHINE_POINT");
      assert.match(duplicate.body.error, /does not move the arm/);
      const edited = await post(firstId, { operation: "capture_image_point", index: 0, x: 105, y: 105 });
      assert.equal(edited.body.calibration.draft.machinePoints[0], null);
    });

    await t.test("jog waits for its exact final controller result, once", async () => {
      await upload(firstId); await a.heartbeat();
      let settled = false;
      const pending = post(firstId, { operation: "jog", axis: "X", distance: 2 }).then(value => { settled = true; return value; });
      const command = await a.nextCommand();
      assert.equal(command.action, "jog"); assert.deepEqual(command.params, { x: 3, y: 2, mode: "calibration" });
      a.commandResult(command.id, true); // Acceptance is not physical completion.
      await pause(100); assert.equal(settled, false);
      b.commandResult(command.id, false, "Another device's failure must not leak.");
      await pause(100); assert.equal(settled, false);
      a.state.grbl.lastOperation = { id: "unrelated-operation", status: "completed" };
      await a.heartbeat(); await pause(100); assert.equal(settled, false);
      a.state.grbl.x = 3; a.state.grbl.lastOperation = { id: command.id, status: "completed" };
      await a.heartbeat();
      const result = await pending;
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.calibration.jog, { id: command.id, status: "completed" });
      assert.equal(a.commands.length, 1);
    });

    await t.test("early command-result rejection returns its real error", async () => {
      await upload(firstId); await a.heartbeat();
      const pending = post(firstId, { operation: "jog", axis: "X", distance: 2 });
      const command = await a.nextCommand();
      a.commandResult(command.id, false, "DEVICE_BUSY: fake controller is still settling");
      const result = await pending;
      assert.equal(result.status, 409); assert.equal(result.body.code, "CALIBRATION_JOG_FAILED");
      assert.match(result.body.error, /fake controller is still settling/);
      assert.equal(a.commands.length, 2);
    });

    await t.test("stale or resized physical frames cannot record a draft point", async () => {
      await upload(firstId, Date.now() - 3_500);
      const stale = await post(firstId, { operation: "capture_image_point", index: 2, x: 600, y: 1100 });
      assert.equal(stale.status, 409); assert.equal(stale.body.code, "FRAME_UNAVAILABLE");
      await upload(firstId, Date.now(), 640, 480);
      const resized = await post(firstId, { operation: "capture_image_point", index: 2, x: 600, y: 400 });
      assert.equal(resized.status, 409); assert.equal(resized.body.code, "CALIBRATION_FRAME_CHANGED");
      await upload(firstId);
    });

    await t.test("unrelated keepalives cannot make stale controller state fresh", async () => {
      a.keepAliveWithoutStatus();
      await pause(6_250); await upload(firstId);
      const stale = await post(firstId, { operation: "capture_machine_point", index: 0 });
      assert.equal(stale.status, 409); assert.equal(stale.body.code, "DEVICE_STATUS_STALE");
      a.resumeHeartbeat(); await a.heartbeat();
    });

    await t.test("missing final confirmation does not resend or unlock another jog", async () => {
      await upload(firstId); await a.heartbeat();
      const pending = post(firstId, { operation: "jog", axis: "X", distance: 2 });
      const command = await a.nextCommand();
      a.commandResult(command.id, true);
      const unconfirmed = await pending;
      assert.equal(unconfirmed.status, 409); assert.equal(unconfirmed.body.code, "CALIBRATION_JOG_UNCONFIRMED");
      await upload(firstId);
      const retry = await post(firstId, { operation: "jog", axis: "X", distance: 2 });
      assert.equal(retry.status, 409); assert.equal(retry.body.code, "CALIBRATION_JOG_PENDING");
      assert.equal(a.commands.length, 3);
    });

    await t.test("server restart restores both unverified drafts without activating them", async () => {
      const readCalibration = async (deviceId: string) => {
        const response = await fetch(`${baseUrl}/api/v1/devices/${deviceId}/calibration`, { headers });
        assert.equal(response.status, 200);
        return (await response.json()).calibration;
      };
      const beforeA = await readCalibration(firstId), beforeB = await readCalibration(secondId);
      assert.ok(beforeA.draft && beforeB.draft);
      a.close(); b.close(); first = null; second = null;
      await stopChild(child!);
      child = launchServer(); await waitHealthy();
      const afterA = await readCalibration(firstId), afterB = await readCalibration(secondId);
      assert.deepEqual(afterA.draft, beforeA.draft);
      assert.deepEqual(afterB.draft, beforeB.draft);
      assert.equal(afterA.active, null); assert.equal(afterB.active, null);
    });
  } finally {
    first?.close(); second?.close();
    if (child) await stopChild(child);
    await rm(temporary, { recursive: true, force: true });
  }
});
