import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  createRentalLease,
  createRentalLeaseToken,
  createRentalShortCode,
  revokeRentalLease,
  writeRentalLeaseRegistry,
  type RentalLeaseRegistry,
} from "../shared/rental-leases.mjs";

function listen(server: Server) {
  return new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate a test port."));
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
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signalTree = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
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

function rejectedWebSocketStatus(url: string, origin: string) {
  return new Promise<number>((resolveStatus, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: origin } });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("WebSocket unexpectedly opened."));
    });
    socket.once("error", (error) => {
      if (socket.readyState !== WebSocket.CLOSED) reject(error);
    });
  });
}

function openedWebSocket(url: string, origin: string) {
  return new Promise<WebSocket>((resolveSocket, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: origin } });
    socket.once("open", () => resolveSocket(socket));
    socket.once("error", reject);
  });
}

function nextLiveFrame(socket: WebSocket) {
  return new Promise<{ metadata: { sequence?: number }; bytes: Buffer }>((resolveFrame, reject) => {
    let metadata: { sequence?: number } | null = null;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a live frame."));
    }, 3_000);
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        metadata = JSON.parse(data.toString()) as { sequence?: number };
        return;
      }
      if (!metadata) return;
      const frame = { metadata, bytes: Buffer.from(data) };
      cleanup();
      resolveFrame(frame);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

test("monthly renter tokens expose only one device and fail closed after revocation", {
  timeout: 30_000,
}, async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "phonebase-rental-gateway-"));
  const registryPath = resolve(temporary, "leases.json");
  const adminToken = "a".repeat(64);
  const signingSecret = "b".repeat(64);
  const origin = "https://console.example";
  const now = new Date();
  const created = createRentalLease(
    { version: 1, leases: [] } satisfies RentalLeaseRegistry,
    {
      deviceId: "black-arm-01",
      customer: "friend@example.com",
      months: 1,
    },
    now,
  );
  await writeRentalLeaseRegistry(registryPath, created.registry);
  const renterToken = createRentalLeaseToken(created.lease, signingSecret);
  let actionRequests = 0;
  let child: ChildProcess | null = null;

  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      send(200, { ok: true, nodes: [{ deviceId: "black-arm-02" }] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/devices") {
      send(200, {
        ok: true,
        devices: [
          {
            id: "black-arm-01",
            connected: true,
            capabilities: { actions: { home: { available: true } } },
          },
          { id: "black-arm-02", connected: true },
        ],
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/actions")) {
      send(200, {
        ok: true,
        receipts: [
          { id: "current", actor: `rental:${created.lease.id}` },
          { id: "previous", actor: "rental:previous-lease" },
        ],
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/actions/previous")) {
      send(200, {
        ok: true,
        receipt: { id: "previous", actor: "rental:previous-lease" },
      });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/v1/devices/")) {
      send(200, {
        ok: true,
        device: {
          id: url.pathname.split("/")[4],
          capabilities: { actions: { home: { available: true } } },
        },
      });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/actions")) {
      actionRequests += 1;
      for await (const chunk of request) {
        // Drain the request before replying.
        void chunk;
      }
      send(202, { ok: true, result: { status: "accepted" } });
      return;
    }
    send(404, { ok: false, error: "Not found" });
  });
  const upstreamLive = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/api/live/socket") {
      socket.destroy();
      return;
    }
    upstreamLive.handleUpgrade(request, socket, head, (liveSocket) => {
      upstreamLive.emit("connection", liveSocket, request);
    });
  });

  try {
    const upstreamPort = await listen(upstream);
    const gatewayPort = await reservePort();
    child = spawn(
      process.execPath,
      ["--import", "tsx", "bridge/remote_gateway.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PHONEBASE_REMOTE_PORT: String(gatewayPort),
          PHONEBASE_REMOTE_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
          PHONEBASE_REMOTE_ALLOWED_ORIGINS: origin,
          PHONEBASE_REMOTE_TOKEN: adminToken,
          PHONEBASE_LEASE_SIGNING_SECRET: signingSecret,
          PHONEBASE_RENTAL_LEASES_PATH: registryPath,
          PHONEBASE_OBSERVABILITY_PATH: resolve(temporary,"observability.sqlite"),
        },
        stdio: "ignore",
        detached: process.platform !== "win32",
      },
    );
    const gateway = `http://127.0.0.1:${gatewayPort}`;
    const headers = {
      Origin: origin,
      Authorization: `Bearer ${renterToken}`,
      "Content-Type": "application/json",
    };
    let health: Response | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      health = await fetch(`${gateway}/health`, { headers }).catch(() => null);
      if (health?.ok) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.equal(health?.status, 200);
    const shortHeaders = { Authorization: `Bearer ${createRentalShortCode(created.lease, signingSecret)}` };
    const shortList = await fetch(`${gateway}/api/v1/devices`, { headers: shortHeaders });
    assert.equal(shortList.status, 200);
    assert.deepEqual(((await shortList.json()) as { devices: { id: string }[] }).devices.map(device => device.id), ["black-arm-01"]);
    assert.equal((await fetch(`${gateway}/api/v1/devices/black-arm-02`, { headers: shortHeaders })).status, 403);
    const healthPayload = await health!.json() as { lease?: { deviceId?: string } };
    assert.equal(healthPayload.lease?.deviceId, "black-arm-01");
    assert.equal(JSON.stringify(healthPayload).includes("black-arm-02"), false);

    const devicesResponse = await fetch(`${gateway}/api/v1/devices`, { headers });
    assert.equal(devicesResponse.status, 200);
    const devices = await devicesResponse.json() as {
      devices: Array<{
        id: string;
        capabilities: { actions: { home: { available: boolean } } };
      }>;
    };
    assert.deepEqual(devices.devices.map((device) => device.id), ["black-arm-01"]);
    assert.equal(devices.devices[0].capabilities.actions.home.available, false);

    const assignedDevice = await fetch(`${gateway}/api/v1/devices/black-arm-01`, { headers });
    assert.equal(assignedDevice.status, 200);
    const assignedPayload = await assignedDevice.json() as {
      device: { capabilities: { actions: { home: { available: boolean } } } };
    };
    assert.equal(assignedPayload.device.capabilities.actions.home.available, false);

    const forbiddenDevice = await fetch(`${gateway}/api/v1/devices/black-arm-02`, { headers });
    assert.equal(forbiddenDevice.status, 403);
    assert.equal(forbiddenDevice.headers.get("x-phonebase-error-code"), "LEASE_SCOPE_DENIED");
    assert.equal((await forbiddenDevice.json() as { code?: string }).code, "LEASE_SCOPE_DENIED");
    const malformedDevice = await fetch(`${gateway}/api/v1/devices/%ZZ`, { headers });
    assert.equal(malformedDevice.status, 403);
    assert.equal(await rejectedWebSocketStatus(
      `ws://127.0.0.1:${gatewayPort}/api/live/socket?deviceId=black-arm-02&access_token=${encodeURIComponent(renterToken)}`,
      origin,
    ), 403);

    const firstConnection = once(upstreamLive, "connection");
    const liveClient = await openedWebSocket(
      `ws://127.0.0.1:${gatewayPort}/api/live/socket?deviceId=black-arm-01&raw=1&flow=latest&access_token=${encodeURIComponent(renterToken)}`,
      origin,
    );
    const [upstreamLiveSocket] = await firstConnection as [WebSocket];
    upstreamLiveSocket.send(JSON.stringify({
      type: "frame",
      mimeType: "application/octet-stream",
      sequence: 1,
    }));
    upstreamLiveSocket.send(Buffer.from("obsolete-frame"));
    upstreamLiveSocket.send(JSON.stringify({
      type: "frame",
      mimeType: "application/octet-stream",
      sequence: 2,
    }));
    upstreamLiveSocket.send(Buffer.from("fresh-frame"));
    const firstFramePromise = nextLiveFrame(liveClient);
    liveClient.send(JSON.stringify({ type: "frame_ready" }));
    const firstFrame = await firstFramePromise;
    assert.equal(firstFrame.metadata.sequence, 2);
    assert.equal(firstFrame.bytes.toString(), "fresh-frame");

    upstreamLiveSocket.send(JSON.stringify({
      type: "frame",
      mimeType: "application/octet-stream",
      sequence: 3,
    }));
    upstreamLiveSocket.send(Buffer.from("obsolete-frame-2"));
    upstreamLiveSocket.send(JSON.stringify({
      type: "frame",
      mimeType: "application/octet-stream",
      sequence: 4,
    }));
    upstreamLiveSocket.send(Buffer.from("newest-frame"));
    const secondFramePromise = nextLiveFrame(liveClient);
    liveClient.send(JSON.stringify({ type: "frame_ack", sequence: 2 }));
    const secondFrame = await secondFramePromise;
    assert.equal(secondFrame.metadata.sequence, 4);
    assert.equal(secondFrame.bytes.toString(), "newest-frame");
    liveClient.close();

    const pipelineConnection = once(upstreamLive, "connection");
    const pipelineClient = await openedWebSocket(
      `ws://127.0.0.1:${gatewayPort}/api/live/socket?deviceId=black-arm-01&flow=latest&window=3&access_token=${encodeURIComponent(renterToken)}`,
      origin,
    );
    const [pipelineUpstream] = await pipelineConnection as [WebSocket];
    let receivedPipelineFrames = 0;
    pipelineClient.on("message", (_data, isBinary) => {
      if (isBinary) receivedPipelineFrames += 1;
    });
    const publishFrame = (sequence: number) => {
      pipelineUpstream.send(JSON.stringify({
        type: "frame", mimeType: "application/octet-stream", sequence,
      }));
      pipelineUpstream.send(Buffer.from(`frame-${sequence}`));
    };
    pipelineClient.send(JSON.stringify({ type: "frame_ready" }));
    for (const sequence of [10, 20, 30]) {
      const framePromise = nextLiveFrame(pipelineClient);
      publishFrame(sequence);
      assert.equal((await framePromise).metadata.sequence, sequence);
    }
    // No more frames may cross the proxy until a real sent frame is acknowledged.
    publishFrame(40);
    publishFrame(50);
    pipelineClient.send(JSON.stringify({ type: "frame_ready" }));
    pipelineClient.send(JSON.stringify({ type: "frame_ack", sequence: 999 }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    assert.equal(receivedPipelineFrames, 3);
    const resumedFrame = nextLiveFrame(pipelineClient);
    pipelineClient.send(JSON.stringify({ type: "frame_ack", sequence: 30 }));
    assert.equal((await resumedFrame).metadata.sequence, 50);
    pipelineClient.close();

    const receiptsResponse = await fetch(
      `${gateway}/api/v1/devices/black-arm-01/actions`,
      { headers },
    );
    assert.equal(receiptsResponse.status, 200);
    const receipts = await receiptsResponse.json() as {
      receipts: Array<{ id: string }>;
    };
    assert.deepEqual(receipts.receipts.map((receipt) => receipt.id), ["current"]);
    const previousReceipt = await fetch(
      `${gateway}/api/v1/devices/black-arm-01/actions/previous`,
      { headers },
    );
    assert.equal(previousReceipt.status, 403);
    assert.equal(previousReceipt.headers.get("x-phonebase-error-code"), "RECEIPT_SCOPE_DENIED");
    assert.equal((await previousReceipt.json() as { code?: string }).code, "RECEIPT_SCOPE_DENIED");

    const phoneHome = await fetch(`${gateway}/api/v1/devices/black-arm-01/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: "rental-phone-home",
        action: { type: "phone_key", key: "home" },
      }),
    });
    assert.equal(phoneHome.status, 202);
    assert.equal(actionRequests, 1);

    const machineHome = await fetch(`${gateway}/api/v1/devices/black-arm-01/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: "rental-machine-home",
        action: { type: "home", confirmation: "CLEAR_WORKSPACE_AND_HOME" },
      }),
    });
    assert.equal(machineHome.status, 403);
    assert.equal(actionRequests, 1);

    const revoked = revokeRentalLease(created.registry, created.lease.id);
    await writeRentalLeaseRegistry(registryPath, revoked.registry);
    const afterRevocation = await fetch(`${gateway}/api/v1/devices`, { headers });
    assert.equal(afterRevocation.status, 401);
    assert.equal(afterRevocation.headers.get("x-phonebase-error-code"), "AUTH_REQUIRED");
    assert.equal((await afterRevocation.json() as { code?: string }).code, "AUTH_REQUIRED");
    assert.equal((await fetch(`${gateway}/api/v1/devices`, { headers: shortHeaders })).status, 401);
  } finally {
    if (child) await stopChild(child);
    upstreamLive.close();
    await closeServer(upstream).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("enterprise keys allow every assigned device over REST and WS, with no-Origin clients and strict cross-customer isolation", {timeout:30_000}, async()=>{
 const temporary=await mkdtemp(resolve(tmpdir(),'phonebase-enterprise-gateway-'));
 const registryPath=resolve(temporary,'leases.json');const secret='enterprise-signing-secret-longer-than-32-characters';const admin='a'.repeat(64);const origin='https://console.example';
 const created=createRentalLease({version:1,leases:[]},{deviceIds:['arm-a','arm-b'],customer:'Acme Engineering'});
 await writeRentalLeaseRegistry(registryPath,created.registry);const token=createRentalLeaseToken(created.lease,secret);
 let actionCount=0;let child:ChildProcess|null=null;let client:WebSocket|null=null;
 const upstream=createServer(async(req,res)=>{const url=new URL(req.url??'/','http://localhost');res.setHeader('Content-Type','application/json');if(req.method==='POST'){actionCount++;for await(const chunk of req)void chunk;res.statusCode=202;res.end(JSON.stringify({ok:true,result:{receipt:{id:'r',actor:`rental:${created.lease.id}`,status:'accepted'}}}));return;}
  const devices=['arm-a','arm-b','other-company'].map(id=>({id,capabilities:{actions:{home:{available:true}}}}));
  if(url.pathname.endsWith('/screenshot')) {res.setHeader('Content-Type','image/jpeg');res.setHeader('X-Phonebase-Captured-At','1789290000000');res.setHeader('X-Phonebase-Frame-Sequence','42');res.setHeader('X-Phonebase-Frame-Width','720');res.setHeader('X-Phonebase-Frame-Height','1560');res.end(Buffer.from([255,216,255,217]));return;}
  if(url.pathname==='/api/v1/devices')res.end(JSON.stringify({ok:true,devices}));
  else if(url.pathname.endsWith('/actions'))res.end(JSON.stringify({ok:true,receipts:[{id:'ours',actor:`rental:${created.lease.id}`},{id:'theirs',actor:'rental:other'}]}));
  else if(url.pathname.endsWith('/actions/theirs'))res.end(JSON.stringify({ok:true,receipt:{id:'theirs',actor:'rental:other'}}));
  else if(url.pathname.startsWith('/api/v1/devices/'))res.end(JSON.stringify({ok:true,device:devices.find(d=>d.id===url.pathname.split('/')[4])}));
  else res.end(JSON.stringify({ok:true}));
 });
 const upstreamLive=new WebSocketServer({noServer:true});upstream.on('upgrade',(req,socket,head)=>upstreamLive.handleUpgrade(req,socket,head,ws=>upstreamLive.emit('connection',ws,req)));
 try{
  const upstreamPort=await listen(upstream);const port=await reservePort();
  child=spawn(process.execPath,['--import','tsx','bridge/remote_gateway.ts'],{cwd:process.cwd(),env:{...process.env,PHONEBASE_REMOTE_PORT:String(port),PHONEBASE_REMOTE_UPSTREAM:`http://127.0.0.1:${upstreamPort}`,PHONEBASE_REMOTE_TOKEN:admin,PHONEBASE_LEASE_SIGNING_SECRET:secret,PHONEBASE_RENTAL_LEASES_PATH:registryPath,PHONEBASE_OBSERVABILITY_PATH:resolve(temporary,"observability.sqlite"),PHONEBASE_REMOTE_ALLOWED_ORIGINS:origin},stdio:'ignore',detached:process.platform!=='win32'});
  const base=`http://127.0.0.1:${port}`;const headers={Authorization:`Bearer ${token}`};
  let healthy=false;for(let i=0;i<80;i++){const response=await fetch(`${base}/health`,{headers}).catch(()=>null);if(response?.ok){healthy=true;break;}await new Promise(r=>setTimeout(r,100));}assert.equal(healthy,true);
  const unauthenticated=await fetch(`${base}/health`);assert.equal(unauthenticated.status,401);assert.equal(unauthenticated.headers.get('x-phonebase-error-code'),'AUTH_REQUIRED');assert.equal(((await unauthenticated.json()) as {code?:string}).code,'AUTH_REQUIRED');
  const originDenied=await fetch(`${base}/health`,{headers:{...headers,Origin:'https://untrusted.example'}});assert.equal(originDenied.status,403);assert.equal(originDenied.headers.get('x-phonebase-error-code'),'ORIGIN_DENIED');assert.equal(((await originDenied.json()) as {code?:string}).code,'ORIGIN_DENIED');
  assert.equal((await fetch(`${base}/health`,{headers:{...headers,Origin:'null'}})).status,403);
  const devices=await (await fetch(`${base}/api/v1/devices`,{headers})).json() as {devices:Array<{id:string}>};assert.deepEqual(devices.devices.map(d=>d.id),['arm-a','arm-b']);
  for(const id of ['arm-a','arm-b']){
   const response=await fetch(`${base}/api/v1/devices/${id}`,{headers});assert.equal(response.status,200);const payload=await response.json() as {device:{capabilities:{actions:{home:{available:boolean}}}}};assert.equal(payload.device.capabilities.actions.home.available,false);
   const receipts=await (await fetch(`${base}/api/v1/devices/${id}/actions`,{headers})).json() as {receipts:Array<{id:string}>};assert.deepEqual(receipts.receipts.map(r=>r.id),['ours']);
   assert.equal((await fetch(`${base}/api/v1/devices/${id}/actions/theirs`,{headers})).status,403);
   const result=await fetch(`${base}/api/v1/devices/${id}/actions`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:`step-${id}`,action:{type:'status'}})});assert.equal(result.status,202);
  }
  assert.equal(actionCount,2);
  const preflight=await fetch(`${base}/api/v1/devices/arm-a/actions`,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,x-request-id,x-phonebase-client'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-max-age'),'600');
  assert.match(preflight.headers.get('access-control-allow-headers')??'',/X-Phonebase-Client/);
  assert.equal((await fetch(`${base}/api/v1/admin/observability`,{headers})).status,404);
  assert.equal((await fetch(`${base}/api/v1/devices/other-company/telemetry`,{method:'POST',headers,body:'{}'})).status,403);

  assert.equal((await fetch(`${base}/api/v1/devices/other-company`,{headers})).status,403);
  const screenshot=await fetch(`${base}/api/v1/devices/arm-b/screenshot`,{headers});
  assert.equal(screenshot.headers.get('x-phonebase-captured-at'),'1789290000000');
  assert.match(screenshot.headers.get('access-control-expose-headers')??'',/X-Phonebase-Captured-At/);
  assert.equal((await screenshot.arrayBuffer()).byteLength,4);
  assert.equal((await fetch(`${base}/api/v1/devices/arm-b/actions`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:'blocked',action:{type:'home',confirmation:'CLEAR_WORKSPACE_AND_HOME'}})})).status,403);
  const remoteSpec=await (await fetch(`${base}/api/v1/openapi.json`,{headers})).json() as {security:unknown;paths:Record<string,unknown>};assert.ok(remoteSpec.security);assert.equal('/api/v1/devices/{deviceId}/calibration' in remoteSpec.paths,false);
  client=await openedWebSocket(`ws://127.0.0.1:${port}/api/live/socket?deviceId=arm-b&access_token=${encodeURIComponent(token)}`,origin);
  assert.equal(client.readyState,WebSocket.OPEN);
  const socketAction=async(action:unknown)=>{
    const reply=once(client!,"message");
    client!.send(JSON.stringify({type:"action_request",requestId:"ws-integration",envelope:{idempotencyKey:"ws-status-step",action}}));
    const [data]=await reply;return JSON.parse(data.toString());
  };
  const socketStatus=await socketAction({type:"status"});assert.equal(socketStatus.status,202);assert.equal(socketStatus.requestId,"ws-integration");assert.equal(actionCount,3);
  const socketHome=await socketAction({type:"home",confirmation:"CLEAR_WORKSPACE_AND_HOME"});assert.equal(socketHome.status,403);assert.equal(actionCount,3);

  assert.equal(await rejectedWebSocketStatus(`ws://127.0.0.1:${port}/api/live/socket?deviceId=other-company&access_token=${encodeURIComponent(token)}`,origin),403);
  await writeRentalLeaseRegistry(registryPath,revokeRentalLease(created.registry,created.lease.id).registry);
  assert.equal((await fetch(`${base}/api/v1/devices/arm-b`,{headers})).status,401);
  assert.equal((await socketAction({type:"status"})).status,401);assert.equal(actionCount,3);
  await Promise.race([once(client,'close'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Revoked stream stayed open')),6500))]);
 }finally{client?.terminate();if(child)await stopChild(child);for(const socket of upstreamLive.clients)socket.terminate();await new Promise<void>(resolveClose=>upstreamLive.close(()=>resolveClose()));await closeServer(upstream);await rm(temporary,{recursive:true,force:true});}
});
