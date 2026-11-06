/** Phonebase remote read-only smoke check. Node.js 22.13+. Never submits actions. */
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function createClient({ baseUrl, token, timeoutMs = 15000 }) {
  const base = new URL(baseUrl);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (
    (!local && base.protocol !== "https:") ||
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw Error("Use the station HTTPS origin, without credentials or a path.");
  if (!token?.trim())
    throw Error("Set PHONEBASE_API_TOKEN to the decoded customer key.");
  async function request(path) {
    if (!path.startsWith("/api/v1/") && !path.startsWith("/health"))
      throw Error("Unsupported read path");
    const response = await fetch(new URL(path, base), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw Error(
        `HTTP ${response.status}: ${body?.error ?? response.statusText}`,
      );
    }
    return response;
  }
  return {
    listDevices: async () =>
      (await (await request("/api/v1/devices")).json()).devices,
    getDevice: async (id) =>
      (
        await (
          await request(`/api/v1/devices/${encodeURIComponent(id)}`)
        ).json()
      ).device,
    screenshot: async (id) => {
      const response = await request(
        `/api/v1/devices/${encodeURIComponent(id)}/screenshot`,
      );
      const integer = (name) => {
        const raw = response.headers.get(name);
        const value = Number(raw);
        if (!raw || !Number.isSafeInteger(value) || value <= 0)
          throw Error(`Invalid ${name} header`);
        return value;
      };
      const type = response.headers.get("content-type")?.split(";")[0];
      if (!["image/jpeg", "image/png", "image/webp"].includes(type))
        throw Error("Expected an image response");
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        mimeType: type,
        frameSequence: integer("x-phonebase-frame-sequence"),
        width: integer("x-phonebase-frame-width"),
        height: integer("x-phonebase-frame-height"),
        capturedAt: integer("x-phonebase-captured-at"),
      };
    },
  };
}

async function main() {
  const client = createClient({
    baseUrl: process.env.PHONEBASE_API_URL ?? "",
    token: process.env.PHONEBASE_API_TOKEN,
  });
  const devices = await client.listDevices();
  console.log(
    JSON.stringify(
      devices.map((d) => ({
        id: d.id,
        connected: d.connected,
        capabilities: d.capabilities,
      })),
      null,
      2,
    ),
  );
  const id = process.env.PHONEBASE_DEVICE_ID;
  if (!id) {
    console.log(
      "Read-only connection verified. Set PHONEBASE_DEVICE_ID to capture an assigned device.",
    );
    return;
  }
  if (!devices.some((d) => d.id === id))
    throw Error("Selected device is not in the assigned-device response.");
  const frame = await client.screenshot(id);
  const extension = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  }[frame.mimeType];
  const stem = `phonebase-frame-${Date.now()}`;
  await writeFile(`${stem}.${extension}`, frame.bytes, {
    mode: 0o600,
    flag: "wx",
  });
  const { bytes, ...metadata } = frame;
  void bytes;
  await writeFile(`${stem}.json`, JSON.stringify(metadata, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    `Saved ${stem}.${extension} and ${stem}.json. No physical action was sent.`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
