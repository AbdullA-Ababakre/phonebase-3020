const API_BASE = process.env.PHONEBASE_API_URL ?? "http://127.0.0.1:3013";
const [deviceId, xValue, yValue, confirmation] = process.argv.slice(2);

function usage() {
  console.error(
    "Usage: npm run example:first-tap -- <deviceId> <x> <y> --execute",
  );
  console.error(
    "This sends one real physical tap. Check the live screen and clear the arm workspace first.",
  );
}

const x = Number(xValue);
const y = Number(yValue);
if (!deviceId || !Number.isFinite(x) || !Number.isFinite(y) || confirmation !== "--execute") {
  usage();
  process.exit(1);
}

async function json(path, init) {
  const response = await fetch(new URL(path, `${API_BASE}/`), init);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${payload.code ?? response.status}: ${payload.error ?? "Request failed"}`);
  }
  return payload;
}

const devicePayload = await json(`/api/v1/devices/${encodeURIComponent(deviceId)}`);
const tapCapability = devicePayload.device?.capabilities?.actions?.tap;
if (tapCapability?.available !== true) {
  throw new Error(`Tap is locked: ${tapCapability?.reason ?? "Device is not ready"}`);
}

const screenshot = await fetch(new URL(
  `/api/v1/devices/${encodeURIComponent(deviceId)}/screenshot`,
  `${API_BASE}/`,
));
if (!screenshot.ok) throw new Error(`Screenshot failed: HTTP ${screenshot.status}`);
const frameSequence = Number(screenshot.headers.get("x-phonebase-frame-sequence"));
const width = Number(screenshot.headers.get("x-phonebase-frame-width"));
const height = Number(screenshot.headers.get("x-phonebase-frame-height"));

const submitted = await json(`/api/v1/devices/${encodeURIComponent(deviceId)}/actions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    idempotencyKey: `first-tap-${crypto.randomUUID()}`,
    action: {
      type: "tap",
      point: { x, y },
      viewport: { width, height },
      frameSequence,
    },
  }),
});

let receipt = submitted.result?.receipt;
if (!receipt?.id) throw new Error("The API did not return an action receipt");
const deadline = Date.now() + 30_000;
while (!["completed", "failed"].includes(receipt.status) && Date.now() < deadline) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  receipt = (await json(
    `/api/v1/devices/${encodeURIComponent(deviceId)}/actions/${encodeURIComponent(receipt.id)}`,
  )).receipt;
}

console.log(JSON.stringify({ deviceId, frameSequence, point: { x, y }, receipt }, null, 2));
if (receipt.status !== "completed") process.exitCode = 2;
