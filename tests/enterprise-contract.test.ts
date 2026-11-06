import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import pages from "../content/docs/pages.json";
import remote from "../public/openapi-remote.json";
import { createClient } from "../examples/remote/inspect.mjs";

test("remote OpenAPI has complete internal references and authenticates every operation", () => {
  const resolveRef = (ref: string) =>
    ref
      .split("/")
      .slice(1)
      .reduce(
        (value: unknown, key) => (value as Record<string, unknown>)?.[key],
        remote,
      );
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if ("$ref" in value)
      assert.ok(resolveRef(String(value.$ref)), `Broken ref: ${value.$ref}`);
    Object.values(value).forEach(visit);
  };
  visit(remote);
  assert.deepEqual(remote.security, [{ customerKey: [] }]);
  assert.equal(remote.components.securitySchemes.customerKey.scheme, "bearer");
  assert.equal("/api/v1/devices/{deviceId}/calibration" in remote.paths, false);
  assert.equal(
    remote.components.schemas.Action.oneOf.some(
      (s) => s.$ref === "#/components/schemas/HomeAction",
    ),
    false,
  );
  for (const methods of Object.values(remote.paths))
    for (const operation of Object.values(methods)) {
      assert.ok(operation.responses["401"]);
      assert.ok(operation.responses["403"]);
    }
});

test("documentation links and machine-readable exports resolve", async () => {
  const slugs = new Set(pages.map((page) => page.slug));
  assert.equal(slugs.size, pages.length);
  for (const page of pages) {
    assert.equal(
      new Set(page.sections.map((s) => s.id)).size,
      page.sections.length,
    );
    const raw = JSON.stringify(page);
    for (const match of raw.matchAll(/\/docs\/([a-z-]+)(?![a-z-])/g)) {
      assert.ok(slugs.has(match[1]), `Unknown docs link ${match[1]}`);
    }
    const markdown = await readFile(
      new URL(`../public/docs/${page.slug}.md`, import.meta.url),
      "utf8",
    );
    assert.ok(markdown.includes(page.title));
  }
  const llms = await readFile(
    new URL("../public/llms.txt", import.meta.url),
    "utf8",
  );
  for (const page of pages) assert.ok(llms.includes(`/docs/${page.slug}.md`));
});

test("published Node example authenticates without Origin, reads exact metadata, and never submits actions", async () => {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    methods.push(req.method ?? "");
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers.authorization, "Bearer test-key");
    if (req.url?.endsWith("/screenshot")) {
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "x-phonebase-frame-sequence": "7",
        "x-phonebase-frame-width": "720",
        "x-phonebase-frame-height": "1280",
        "x-phonebase-captured-at": "1780000000000",
      });
      res.end(Buffer.from([255, 216, 255, 217]));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ devices: [{ id: "arm-a", connected: true }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const client = createClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "test-key",
    });
    assert.equal((await client.listDevices())[0].id, "arm-a");
    const frame = await client.screenshot("arm-a");
    assert.equal(frame.frameSequence, 7);
    assert.equal(frame.width, 720);
    assert.equal(frame.height, 1280);
    assert.deepEqual(methods, ["GET", "GET"]);
    assert.throws(
      () => createClient({ baseUrl: "http://remote.example", token: "key" }),
      /HTTPS/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
