import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const expectedTools = [
  "phonebase_list_devices",
  "phonebase_get_device",
  "phonebase_get_screenshot",
  "phonebase_observe",
  "phonebase_tap_text",
  "phonebase_open_app",
  "phonebase_hover_move",
  "phonebase_tap",
  "phonebase_long_press",
  "phonebase_swipe",
  "phonebase_input_text",
  "phonebase_phone_key",
  "phonebase_status",
  "phonebase_hold",
  "phonebase_resume",
  "phonebase_wait",
  "phonebase_get_receipt",
].sort();

test("MCP onboarding uses the deployed download host and matching standalone checksum", async () => {
  const root = new URL("../", import.meta.url);
  const clientUrl = "https://console.phonefarm.ai/downloads/phonebase-mcp.mjs";
  for (const path of [
    "content/docs/pages.json", "app/dashboard-content.tsx", "public/docs/mcp.md",
    "public/agent-guide.txt", "public/llms-full.txt", "docs/mintlify/mcp.mdx",
  ]) {
    const content = await readFile(new URL(path, root), "utf8");
    assert.ok(content.includes(clientUrl), `${path}: missing deployed client URL`);
    assert.ok(content.includes(`${clientUrl}.sha256`), `${path}: missing checksum URL`);
    assert.ok(!content.includes("https://phoneuse.com/downloads/phonebase-mcp"), `${path}: broken marketing-host download`);
  }
  const client = await readFile(new URL("public/downloads/phonebase-mcp.mjs", root));
  const manifest = await readFile(new URL("public/downloads/phonebase-mcp.mjs.sha256", root), "utf8");
  assert.equal(manifest.trim().split(/\s+/)[0], createHash("sha256").update(client).digest("hex"));
});

async function connect(mode, overrides = {}) {
  const client = new Client(
    { name: `phonebase-test-${mode}`, version: "1.0.0" },
    mode === "modern"
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : undefined,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["node_modules/tsx/dist/cli.mjs", "mcp/server.ts"],
    cwd: process.cwd(),
    env: { ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry) => typeof entry[1] === "string",
      ),
    ), PHONEBASE_MCP_ALLOW_HOME: "0", ...overrides },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

for (const mode of ["legacy", "modern"]) {
  test(`MCP ${mode} clients discover the complete hardware surface`, async () => {
    const { client, transport } = await connect(mode);
    try {
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        expectedTools,
      );
      const tap = tools.tools.find((tool) => tool.name === "phonebase_tap");
      assert.ok(tap.inputSchema.required.includes("idempotencyKey"));
      assert.equal(tap.inputSchema.properties.durationMs.minimum, 30);
      assert.equal(tap.inputSchema.properties.durationMs.maximum, 40);
      assert.equal(tap.annotations.idempotentHint, true);
      for (const visualToolName of ["phonebase_tap_text", "phonebase_open_app"]) {
        const visualTool = tools.tools.find((tool) => tool.name === visualToolName);
        assert.ok(visualTool.inputSchema.required.includes("idempotencyKey"));
        assert.equal(visualTool.annotations.idempotentHint, true);
      }
      assert.equal(
        tools.tools.find((tool) => tool.name === "phonebase_observe").annotations.readOnlyHint,
        true,
      );
      assert.equal(client.getServerVersion()?.version, "0.7.0");
      if (mode === "modern") {
        assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
        assert.equal(client.getProtocolEra(), "modern");
      }
    } finally {
      await client.close();
      await transport.close();
    }
  });
}

test("standalone client starts without project dependencies and authenticates a read-only API call", async () => {
  const { createServer } = await import("node:http");
  const { mkdtemp, copyFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const temporary = await mkdtemp(join(tmpdir(), "phonebase-portable-mcp-"));
  await copyFile(
    new URL("../public/downloads/phonebase-mcp.mjs", import.meta.url),
    join(temporary, "phonebase-mcp.mjs"),
  );
  let reads = 0;
  const api = createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, "Bearer portable-test-key");
    assert.equal(request.headers.origin, undefined);
    reads++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        devices: [
          {
            id: "assigned-arm",
            connected: true,
            capabilities: {
              actions: { tap: { available: false, reason: "No frame" } },
            },
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const client = new Client({ name: "portable-mcp-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(temporary, "phonebase-mcp.mjs")],
    cwd: temporary,
    env: {
      PATH: process.env.PATH,
      PHONEBASE_API_URL: `http://127.0.0.1:${api.address().port}`,
      PHONEBASE_API_TOKEN: "portable-test-key",
      PHONEBASE_MCP_ALLOW_REMOTE: "1",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 17);
    assert.equal(
      tools.tools.find((tool) => tool.name === "phonebase_tap").annotations
        .idempotentHint,
      true,
    );
    const result = await client.callTool({
      name: "phonebase_list_devices",
      arguments: {},
    });
    assert.notEqual(result.isError, true);
    assert.ok(JSON.stringify(result).includes("assigned-arm"));
    assert.equal(reads, 1);
    await assert.rejects(client.callTool({
      name: "phonebase_home",
      arguments: { deviceId: "assigned-arm", workspaceClear: true },
    }), /Tool phonebase_home not found/);
    assert.equal(reads, 1);
  } finally {
    await client.close();
    await transport.close();
    await new Promise((resolve) => api.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('MCP validates frame metadata, preserves retry IDs and exposes structured failures', async () => {
  const {createServer}=await import('node:http');
  const seen=[];
  const api=createServer(async(req,res)=>{
    if(req.url.endsWith('/screenshot')){res.writeHead(200,{'Content-Type':'image/jpeg','X-Phonebase-Frame-Sequence':'1','X-Phonebase-Frame-Width':'720','X-Phonebase-Frame-Height':'1560'});res.end(Buffer.from([255,216,255,217]));return;}
    if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;seen.push(JSON.parse(raw));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result:{receipt:{id:'failed-step',status:'failed',error:'Device disconnected'}}}));return;}
    res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Not assigned',code:'LEASE_SCOPE_DENIED'}));
  });
  await new Promise(r=>api.listen(0,'127.0.0.1',r));
  const transport=new StdioClientTransport({command:process.execPath,args:['public/downloads/phonebase-mcp.mjs'],env:{...process.env,PHONEBASE_API_URL:`http://127.0.0.1:${api.address().port}`},stderr:'pipe'});
  const client=new Client({name:'error-contract-test',version:'1'});
  try{
    await client.connect(transport);
    const frame=await client.callTool({name:'phonebase_get_screenshot',arguments:{deviceId:'arm'}});
    assert.equal(frame.isError,true);assert.equal(JSON.parse(frame.content[0].text).code,'INVALID_FRAME_METADATA');assert.ok(frame.content.every(c=>c.type!=='image'));
    const denied=await client.callTool({name:'phonebase_get_device',arguments:{deviceId:'arm'}});
    assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content[0].text).httpStatus,403);
    assert.equal(JSON.parse(denied.content[0].text).code,'LEASE_SCOPE_DENIED');
    for(let i=0;i<2;i++){const failed=await client.callTool({name:'phonebase_wait',arguments:{deviceId:'arm',durationMs:100,idempotencyKey:'same-workflow-step'}});assert.equal(failed.isError,true);}
    assert.equal(seen.length,2);assert.equal(seen[0].idempotencyKey,'same-workflow-step');assert.deepEqual(seen[0],seen[1]);
  }finally{await client.close();await transport.close();await new Promise(r=>api.close(r));}
});

test("visual MCP tools use the station-side OCR endpoint and preserve workflow IDs", async () => {
  const { createServer } = await import("node:http");
  const requests = [];
  const api = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, body: JSON.parse(raw) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      result: { receipt: { id: "visual-complete", status: "completed" } },
    }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const { client, transport } = await connect("modern", {
    PHONEBASE_API_URL: `http://127.0.0.1:${api.address().port}`,
  });
  try {
    const opened = await client.callTool({
      name: "phonebase_open_app",
      arguments: {
        deviceId: "arm one",
        appName: "Weather",
        idempotencyKey: "open-weather-step",
      },
    });
    assert.notEqual(opened.isError, true);
    assert.deepEqual(requests, [{
      method: "POST",
      url: "/api/v1/devices/arm%20one/visual-actions",
      body: {
        idempotencyKey: "open-weather-step",
        action: { type: "open_app", appName: "Weather" },
      },
    }]);
  } finally {
    await client.close();
    await transport.close();
    await new Promise((resolve) => api.close(resolve));
  }
});

test("phonebase_observe returns the image, exact frame metadata, and live device state together", async () => {
  const { createServer } = await import("node:http");
  const capturedAt = Date.now() - 25;
  const api = createServer((request, response) => {
    if (request.url?.endsWith("/screenshot")) {
      response.writeHead(200, {
        "content-type": "image/jpeg",
        "x-phonebase-frame-sequence": "44",
        "x-phonebase-captured-at": String(capturedAt),
        "x-phonebase-frame-width": "720",
        "x-phonebase-frame-height": "1560",
      });
      response.end(Buffer.from([255, 216, 255, 217]));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, device: { id: "arm", connected: true } }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const { client, transport } = await connect("modern", {
    PHONEBASE_API_URL: `http://127.0.0.1:${api.address().port}`,
  });
  try {
    const observation = await client.callTool({
      name: "phonebase_observe",
      arguments: { deviceId: "arm" },
    });
    assert.notEqual(observation.isError, true);
    assert.equal(observation.content[0].type, "image");
    const details = JSON.parse(observation.content.find((item) => item.type === "text").text);
    assert.equal(details.frameSequence, 44);
    assert.equal(details.frameWidth, 720);
    assert.equal(details.frameHeight, 1560);
    assert.equal(details.device.id, "arm");
    assert.equal(details.device.connected, true);
  } finally {
    await client.close();
    await transport.close();
    await new Promise((resolve) => api.close(resolve));
  }
});

test("an action polling timeout is an MCP error with a recoverable receipt", async () => {
  const { createServer } = await import("node:http");
  const api = createServer(async (request, response) => {
    if (request.method === "POST") {
      for await (const _chunk of request) void _chunk;
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        result: { receipt: { id: "still-running", status: "executing" } },
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ receipt: { id: "still-running", status: "executing" } }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const { client, transport } = await connect("modern", {
    PHONEBASE_API_URL: `http://127.0.0.1:${api.address().port}`,
    PHONEBASE_MCP_ACTION_TIMEOUT_MS: "5000",
  });
  try {
    const result = await client.callTool({
      name: "phonebase_wait",
      arguments: { deviceId: "arm", durationMs: 1, idempotencyKey: "timeout-test-step" },
    });
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.mcp.timedOut, true);
    assert.equal(payload.mcp.nextTool, "phonebase_get_receipt");
    assert.equal(payload.result.receipt.id, "still-running");
  } finally {
    await client.close();
    await transport.close();
    await new Promise((resolve) => api.close(resolve));
  }
});

for (const remote of [false, true]) {
  test(`mechanical Home discovery requires explicit local operator access (remote=${remote})`, async () => {
    const { client, transport } = await connect("legacy", {
      PHONEBASE_API_URL: remote ? "https://station.example" : "http://127.0.0.1:3013",
      PHONEBASE_MCP_ALLOW_REMOTE: "1", PHONEBASE_API_TOKEN: "test-only",
      PHONEBASE_MCP_ALLOW_HOME: "1",
    });
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.some(tool => tool.name === "phonebase_home"), !remote);
      assert.equal(tools.some(tool => tool.name === "phonebase_phone_key"), true);
    } finally { await client.close(); await transport.close(); }
  });
}
