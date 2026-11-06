import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import type { PhonebaseCalibrationProfile } from "../agent/calibration-profile";

const profile: PhonebaseCalibrationProfile = {
  id: "mock-station-v1",
  deviceId: "mock-arm-01",
  verified: true,
  verifiedAt: "2026-08-28T00:00:00.000Z",
  frame: { width: 720, height: 1280 },
  screen: { width: 720, height: 1560 },
  imagePoints: [
    { x: 100, y: 80 },
    { x: 620, y: 80 },
    { x: 620, y: 1200 },
    { x: 100, y: 1200 },
  ],
  machinePoints: [
    { x: 70, y: 146 },
    { x: 14, y: 146 },
    { x: 14, y: 14 },
    { x: 70, y: 14 },
  ],
  safeMachineBounds: {
    minimumX: 15,
    maximumX: 69,
    minimumY: 15,
    maximumY: 145,
  },
  tap: { hoverZ: 1, touchZ: 10, zStep: 0.5, feed: 3000, dwellMs: 40 },
};

function listen(server: Server) {
  return new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate a local test port."));
        return;
      }
      resolvePort(address.port);
    });
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function reservePort() {
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  return port;
}

async function waitForHealth(url: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Auto-setup test service exited with ${child.exitCode}.`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(250) });
      if (response.ok) return;
    } catch {
      // Startup can include one native Swift compilation on a clean machine.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Auto-setup test service did not become healthy.");
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signalTree = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signalTree("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) signalTree("SIGKILL");
}

test("previews, trusts, and dry-runs a camera reference without hardware actions", {
  skip: process.platform !== "darwin",
  timeout: 120_000,
}, async () => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "phonebase-auto-setup-test-"));
  let frame = await sharp({
    create: {
      width: 720,
      height: 1280,
      channels: 3,
      background: { r: 12, g: 18, b: 28 },
    },
  }).composite([{
    input: Buffer.from(`
      <svg width="720" height="1280" xmlns="http://www.w3.org/2000/svg">
        <rect x="100" y="80" width="520" height="1120" rx="34" fill="#f4f7fb"/>
        <rect x="130" y="130" width="190" height="130" rx="18" fill="#ef5350"/>
        <rect x="400" y="130" width="190" height="130" rx="18" fill="#42a5f5"/>
        <circle cx="220" cy="430" r="82" fill="#66bb6a"/>
        <circle cx="500" cy="430" r="82" fill="#ab47bc"/>
        <path d="M150 650 L570 650 L500 1060 L220 1060 Z" fill="#ffca28"/>
        <text x="360" y="1160" text-anchor="middle" font-size="54" fill="#17202a">Phonebase</text>
      </svg>
    `),
  }]).jpeg({ quality: 88 }).toBuffer();
  let actionRequests = 0;
  let profileWrites = 0;
  let calibrationAvailable = false;
  let activeProfile = profile;
  let activatedNavigationStrategy: string | null = null;

  const mockControlPlane = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/api/v1/devices/mock-arm-01") {
      json({
        ok: true,
        device: {
          id: activeProfile.deviceId,
          connected: true,
          state: {
            cameraReady: true,
            grbl: {
              connected: true,
              homed: false,
              state: "Alarm",
              activeOperation: null,
              movementBounds: {
                minimumX: 5.8,
                maximumX: 78.5,
                minimumY: 10.5,
                maximumY: 168,
              },
            },
          },
          screen: { width: 720, height: 1560, rawWidth: 720, rawHeight: 1280 },
        },
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/devices/mock-arm-01/calibration"
    ) {
      json({ ok: true, calibration: { active: calibrationAvailable ? activeProfile : null } });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/devices/mock-arm-01/screenshot"
    ) {
      assert.equal(url.searchParams.get("source"), "camera", "calibration must explicitly select the physical camera when mirroring is active");
      response.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": String(frame.length),
        "X-Phonebase-Frame-Sequence": "77",
        "X-Phonebase-Frame-Width": "720",
        "X-Phonebase-Frame-Height": "1280",
      });
      response.end(frame);
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/actions")) {
      actionRequests += 1;
      json({ ok: false, error: "The mock forbids actions." }, 500);
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/calibration")) {
      profileWrites += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        profile: PhonebaseCalibrationProfile;
      };
      activeProfile = body.profile;
      calibrationAvailable = true;
      activatedNavigationStrategy = activeProfile.navigation?.home.strategy ?? null;
      json({ ok: true, calibration: { active: activeProfile } });
      return;
    }
    json({ ok: false, error: "Not found" }, 404);
  });

  let child: ChildProcess | null = null;
  try {
    const controlPlanePort = await listen(mockControlPlane);
    const autoSetupPort = await reservePort();
    child = spawn(
      process.execPath,
      ["--import", "tsx", "auto-setup/server.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PHONEBASE_AUTO_SETUP_PORT: String(autoSetupPort),
          PHONEBASE_AUTO_SETUP_STATE_DIRECTORY: stateDirectory,
          PHONEBASE_CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlanePort}`,
        },
        stdio: "ignore",
        detached: process.platform !== "win32",
      },
    );
    const baseUrl = `http://127.0.0.1:${autoSetupPort}`;
    await waitForHealth(`${baseUrl}/health`, child);

    const modelRequired = await fetch(`${baseUrl}/v1/devices/mock-arm-01/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(modelRequired.status, 200);
    assert.equal(
      (await modelRequired.json() as { status: string }).status,
      "model_required",
    );

    const model = await fetch(`${baseUrl}/v1/devices/mock-arm-01/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "iphone-face-id" }),
    });
    assert.equal(model.status, 200);

    const uncalibratedPreview = await fetch(`${baseUrl}/v1/devices/mock-arm-01/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(uncalibratedPreview.status, 200);
    const uncalibrated = await uncalibratedPreview.json() as {
      status: string;
      frame: { sequence: number };
      activeImagePoints: unknown;
    };
    assert.equal(uncalibrated.status, "baseline_required");
    assert.equal(uncalibrated.frame.sequence, 77);
    assert.equal(uncalibrated.activeImagePoints, null);
    assert.equal(actionRequests, 0);

    calibrationAvailable = true;

    const firstPreview = await fetch(`${baseUrl}/v1/devices/mock-arm-01/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(firstPreview.status, 200);
    const baseline = await firstPreview.json() as { status: string; frame: { sequence: number } };
    assert.equal(baseline.status, "baseline_required");
    assert.equal(baseline.frame.sequence, 77);

    const saved = await fetch(`${baseUrl}/v1/devices/mock-arm-01/reference`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        frameSequence: baseline.frame.sequence,
        confirmation: "CURRENT_PLACEMENT_MATCHES_ACTIVE_CALIBRATION",
      }),
    });
    const savedBody = await saved.text();
    assert.equal(saved.status, 201, savedBody);
    assert.equal(profileWrites, 1);
    assert.equal(activatedNavigationStrategy, "screen-swipe");

    const dryRun = await fetch(`${baseUrl}/v1/devices/mock-arm-01/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(dryRun.status, 200);
    const result = await dryRun.json() as {
      status: string;
      moved: boolean;
      profileUpdated: boolean;
      preview: { status: string; registration: { confidence: number } };
    };
    assert.equal(result.status, "previewed");
    assert.equal(result.moved, false);
    assert.equal(result.profileUpdated, false);
    assert.equal(result.preview.status, "ready");
    assert.ok(result.preview.registration.confidence >= 0.78);
    assert.equal(actionRequests, 0);
    assert.equal(profileWrites, 1);

    activeProfile = { ...activeProfile, imagePoints: activeProfile.imagePoints.map(point => ({x: point.x + 1, y: point.y})) as typeof activeProfile.imagePoints };
    const changedPreview = await fetch(`${baseUrl}/v1/devices/mock-arm-01/preview`, { method: "POST" });
    assert.equal(changedPreview.status, 200);
    const changed = await changedPreview.json() as { status: string; proposedImagePoints: unknown };
    assert.equal(changed.status, "baseline_required", "outdated references must allow a fresh review");
    assert.equal(actionRequests, 0);
    assert.equal(profileWrites, 1, "preview must not activate a new calibration");

    frame = await sharp({
      create: {
        width: 720,
        height: 1280,
        channels: 3,
        background: { r: 2, g: 1, b: 3 },
      },
    }).jpeg({ quality: 88 }).toBuffer();
    const blankPreview = await fetch(`${baseUrl}/v1/devices/mock-arm-01/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(blankPreview.status, 409);
    const blankResult = await blankPreview.json() as { code: string };
    assert.equal(blankResult.code, "CAMERA_FRAME_UNUSABLE");
    assert.equal(actionRequests, 0);
    assert.equal(profileWrites, 1);
  } finally {
    if (child) await stopChild(child);
    await closeServer(mockControlPlane).catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
