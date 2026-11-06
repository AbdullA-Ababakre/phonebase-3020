import { WebSocket } from "ws";

// Read-only diagnostics: obtains the existing device lease from the local
// administrator API, then measures that same lease through its public gateway.
const deviceId = process.argv[2] ?? "black-arm-02";
const windowSize = process.argv[3] ?? "3";
const durationMs = 15_000;
const local = process.env.PHONEBASE_API_URL ?? "http://127.0.0.1:3013";
const adminResponse = await fetch(`${local}/api/v1/admin/rentals`);
if (!adminResponse.ok) throw new Error(`Rental lookup failed (${adminResponse.status})`);
const rentals = await adminResponse.json();
const lease = rentals.leases.find((value) => value.deviceId === deviceId && value.accessCode);
if (!lease) throw new Error("No active rental for this device.");
const { readPhonebaseAccessCode } = await import("../shared/connection-code.mjs");
const { gatewayUrl, token } = readPhonebaseAccessCode(lease.accessCode);
const origin = new URL(rentals.consoleUrl).origin;
const apiMs = [];
for (let attempt = 0; attempt < 4; attempt += 1) {
  const start = performance.now();
  const response = await fetch(`${gatewayUrl}/api/v1/devices`, {
    headers: { Authorization: `Bearer ${token}`, Origin: origin },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Gateway failed (${response.status})`);
  await response.arrayBuffer();
  apiMs.push(Math.round(performance.now() - start));
}

const summary = await new Promise((resolve, reject) => {
  const url = new URL("/api/live/socket", gatewayUrl);
  url.protocol = "wss:";
  url.search = new URLSearchParams({
    deviceId, flow: "latest", window: windowSize, quality: "preview", access_token: token,
  }).toString();
  const start = performance.now();
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  let metadata;
  let firstFrameMs = 0;
  let lastAt = 0;
  let bytes = 0;
  const frameAgesMs = [];
  const frameIntervalsMs = [];
  const timer = setTimeout(() => {
    socket.close();
    const p50 = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null;
    resolve({
      gateway: gatewayUrl, deviceId, window: Number(windowSize), apiMs,
      firstFrameMs: Math.round(firstFrameMs), frames: frameAgesMs.length,
      fps: frameAgesMs.length > 1
        ? Number(((frameAgesMs.length - 1) * 1_000 / (lastAt - start - firstFrameMs)).toFixed(2)) : 0,
      medianFrameAgeMs: p50(frameAgesMs), medianFrameIntervalMs: p50(frameIntervalsMs),
      bytes, frameAgesMs, frameIntervalsMs,
    });
  }, durationMs);
  socket.on("open", () => socket.send(JSON.stringify({ type: "frame_ready" })));
  socket.on("message", (data, binary) => {
    if (!binary) {
      try { metadata = JSON.parse(data.toString()); } catch { metadata = null; }
      return;
    }
    if (metadata?.type !== "frame") return;
    const now = performance.now();
    if (!firstFrameMs) firstFrameMs = now - start;
    if (lastAt) frameIntervalsMs.push(Math.round(now - lastAt));
    lastAt = now;
    bytes += data.length;
    frameAgesMs.push(Date.now() - metadata.capturedAt);
    socket.send(JSON.stringify({ type: "frame_ack", sequence: metadata.sequence }));
  });
  socket.once("error", (error) => { clearTimeout(timer); socket.terminate(); reject(error); });
});
console.log(JSON.stringify(summary, null, 2));
