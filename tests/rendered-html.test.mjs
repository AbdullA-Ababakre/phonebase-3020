import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { readPhonebaseAccessCode } from "../shared/connection-code.mjs";

const execFileAsync = promisify(execFile);

async function render(pathname = "/", host = "localhost") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://${host}${pathname}`, {
      headers: { accept: "text/html", host },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Phonebase multi-device wall", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Phonebase · Device Platform<\/title>/i);
  assert.match(html, /Devices/);
  assert.match(html, /Search devices/);
  assert.match(html, /Hold all/);
  assert.match(html, /Complete setup/);
  assert.match(html, /Customer access/);
  assert.match(html, /API &amp; MCP/);
  assert.match(html, /Recorder/);
  assert.doesNotMatch(html, /Phonebase Agent/);
  assert.doesNotMatch(html, /natural language/i);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("server-renders remote-first documentation and enterprise product entry", async () => {
  const docs = await render("/docs");
  assert.equal(docs.status, 200);
  const html = await docs.text();
  assert.match(html, /Build on real devices/);
  assert.match(html, /Use a device in the browser/);
  assert.match(html, /API reference/);
  assert.match(html, /Search documentation/);
  const publicPage = await render("/", "phonebase.example.com");
  const publicHtml = await publicPage.text();
  assert.match(publicHtml, /Your software/);
  assert.match(publicHtml, /The real world/);
  assert.doesNotMatch(publicHtml, /Search devices|Hold all/);
});

test("all documentation routes render content and unknown pages return 404", async () => {
  const pages = JSON.parse(await readFile(new URL("../content/docs/pages.json", import.meta.url), "utf8"));
  for (const page of pages) {
    const response = await render(`/docs/${page.slug}`);
    assert.equal(response.status, 200, page.slug);
    const html = await response.text();
    assert.ok(html.includes('main-content'), page.slug);
    assert.ok(html.includes(`/docs/${page.slug}.md`), page.slug);
  }
  assert.equal((await render("/docs/not-a-real-page")).status, 404);
});

test("server-renders a one-code Cloud Console pairing screen", async () => {
  const response = await render("/console", "phonebase.example.com");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Phonebase Cloud Beta Console<\/title>/i);
  assert.match(html, /Open your workspace/);
  assert.match(html, /Invitation link or access code/);
  assert.doesNotMatch(html, /HTTPS gateway|Private access token/);
  assert.doesNotMatch(html, /Hold all|Search devices/);
});

test("creates a one-click cloud link with the secret in the fragment", async () => {
  const token = "a".repeat(64);
  const { stdout } = await execFileAsync(
    process.execPath,
    [new URL("../bin/phonebase.mjs", import.meta.url).pathname, "cloud-link", "https://station.example"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        PHONEBASE_REMOTE_TOKEN: token,
        PHONEBASE_CLOUD_CONSOLE_URL: "https://phonebase.co/console",
        PHONEBASE_REMOTE_ALLOWED_ORIGINS: "https://phonebase.co",
      },
    },
  );
  const link = new URL(stdout.trim());
  assert.equal(link.pathname, "/console");
  assert.equal(link.search, "");
  const fragment = new URLSearchParams(link.hash.slice(1));
  const accessCode = fragment.get("access") ?? "";
  assert.match(accessCode, /^pb_connect_v1\./);
  assert.deepEqual(readPhonebaseAccessCode(accessCode), {
    gatewayUrl: "https://station.example",
    token,
  });
  assert.equal(fragment.has("controlPlane"), false);
  assert.equal(fragment.has("token"), false);
});

test("ships a portable installer, CLI, and complete Agent handoff", async () => {
  const [packageJsonText, cli, installer, guide, serviceManager, releaseBuilder] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../bin/phonebase.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/install.sh", import.meta.url), "utf8"),
    readFile(new URL("../public/agent-guide.txt", import.meta.url), "utf8"),
    readFile(new URL("../scripts/service-manager-macos.py", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build-release-macos.sh", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonText);

  assert.equal(packageJson.version, "0.7.0");
  assert.equal(packageJson.bin.phonebase, "./bin/phonebase.mjs");
  assert.match(cli, /Safety: installation and onboarding never home or move the arm/);
  assert.match(cli, /case "mcp"/);
  assert.match(cli, /agent-guide --copy/);
  assert.match(cli, /cloud-link --copy/);
  assert.match(cli, /lease create --device/);
  assert.match(cli, /case "lease"/);
  assert.match(installer, /shasum -a 256/);
  assert.match(installer, /ARCHIVE_SHA256="[a-f0-9]{64}"/);
  assert.doesNotMatch(installer, /__PHONEBASE_ARCHIVE_SHA256__/);
  assert.match(installer, /Never home or move the arm/);
  assert.match(installer, /phonebase-macos\.tgz/);
  assert.match(serviceManager, /PHONEBASE_FLEET_START_CONTROL_PLANE/);
  assert.match(serviceManager, /PHONEBASE_CONTROL_PLANE_PORT/);
  assert.match(serviceManager, /PHONEBASE_CAMERA_BROKER_APP/);
  assert.match(installer, /build-camera-broker-macos\.sh/);
  assert.match(packageJson.scripts["release:macos"], /build-release-macos\.sh/);
  assert.match(releaseBuilder, /git -C "\$phonebase_root" ls-files -z/);
  assert.match(releaseBuilder, /__PHONEBASE_ARCHIVE_SHA256__/);

  for (const tool of [
    "phonebase_list_devices",
    "phonebase_get_device",
    "phonebase_get_screenshot",
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
    "phonebase_home",
    "phonebase_wait",
    "phonebase_get_receipt",
  ]) {
    assert.match(guide, new RegExp(tool));
  }
  assert.match(guide, /node phonebase-mcp\.mjs --configure/);
  assert.doesNotMatch(guide, /YOUR_STATION_HOST|phonebase-cloud-beta\.alhazaranwar205\.chatgpt\.site/);
  assert.doesNotMatch(guide, /"cwd"|\/Users\/jfg|OPPO|red arm|红色机械臂/i);
});

test("removes the retired red-arm and Android camera-node product path", async () => {
  const [packageJson, environment, readme] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  for (const path of [
    "../bridge/serial_bridge.py",
    "../bridge/adb_camera_node.py",
    "../scripts/install-oppo-node.sh",
    "../app/camera/page.tsx",
  ]) {
    await assert.rejects(
      access(new URL(path, import.meta.url)),
      (error) => error?.code === "ENOENT",
    );
  }
  assert.doesNotMatch(packageJson, /serial_bridge|camera:adb|install:oppo/);
  assert.doesNotMatch(environment, /ENABLE_MAC_BRIDGE|ENABLE_ADB_CAMERA/);
  assert.doesNotMatch(readme, /[\u4e00-\u9fff]/);
});

test("keeps live phone actions behind the physical safety gate", async () => {
  const [page, controlPlane, driver, contract] = await Promise.all([
    readFile(new URL("../app/dashboard-content.tsx", import.meta.url), "utf8"),
    readFile(new URL("../agent/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../bridge/black_arm_driver.py", import.meta.url), "utf8"),
    readFile(new URL("../agent/action-contract.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /controlEnabled && device\.connected && device\.capabilities\.actions\.tap\.available/);
  assert.match(page, /Physical control is live/);
  assert.match(page, /\/api\/v1\/devices\/\$\{encodeURIComponent\(device\.id\)\}\/actions/);
  assert.match(driver, /MIN_TOUCH_Z = float\([^\n]+"9\.5"/);
  assert.match(driver, /MAX_Z = float\([^\n]+"10\.0"/);
  assert.match(controlPlane, /const physicalTapReady = phonebaseDeviceIds\(\)\.some/);
  assert.match(controlPlane, /physicalTap: physicalTapReady/);
  assert.match(controlPlane, /calibrationReady: readiness\.ready/);
  assert.match(controlPlane, /grbl\.calibrationActive !== true/);
  assert.match(controlPlane, /grbl\.homed !== true/);
  assert.match(controlPlane, /grbl\.state !== "Idle"/);
  assert.match(controlPlane, /executeSemanticAction/);
  assert.doesNotMatch(controlPlane, /runPhonebaseGoal/);
  assert.doesNotMatch(controlPlane, /\/api\/v1\/agent\/tasks/);
  assert.doesNotMatch(controlPlane, /\/api\/commands/);
  assert.match(contract, /type: "input_text"/);
  assert.match(contract, /type: "phone_key"/);
  assert.match(page, /supportedKeys\?\.includes\("home"\)/);
  assert.match(page, /type: "phone_key", key: "home"/);
});

test("reuses the calibrated phone controls inside fullscreen focus mode", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/dashboard-content.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /mode\?: "grid" \| "focus"/);
  assert.match(page, /mode="focus"/);
  assert.match(page, /controlEnabled=\{controlActive && !focusedDevice\}/);
  assert.match(page, /Focus mode .*Back for/);
  assert.match(page, /Focus mode .*Home for/);
  assert.match(page, /Click, press, or drag directly on the phone/);
  assert.match(page, /aria-label="Exit focus mode"/);
  assert.match(page, /event\.key !== "Escape"/);
  assert.match(page, /className="fullscreen-trigger"/);
  assert.match(page, /<span>Full screen<\/span>/);
  assert.match(page, /document\.documentElement\.requestFullscreen/);
  assert.match(page, /document\.exitFullscreen/);
  assert.match(page, /"fullscreenchange"/);
  assert.match(styles, /\.focus-device/);
  assert.match(styles, /\.focus-control-toggle\.enabled/);
  assert.match(styles, /\.device-toolbar-actions button\.fullscreen-trigger/);
});

test("publishes the full local MCP hardware surface", async () => {
  const mcp = await readFile(new URL("../mcp/server.ts", import.meta.url), "utf8");
  for (const tool of [
    "phonebase_list_devices",
    "phonebase_get_device",
    "phonebase_get_screenshot",
    "phonebase_hover_move",
    "phonebase_tap",
    "phonebase_long_press",
    "phonebase_swipe",
    "phonebase_input_text",
    "phonebase_phone_key",
    "phonebase_home",
    "phonebase_wait",
    "phonebase_get_receipt",
  ]) {
    assert.match(mcp, new RegExp(tool));
  }
  assert.match(mcp, /\["status", "hold", "resume"\]/);
  assert.match(mcp, /CLEAR_WORKSPACE_AND_HOME/);
  assert.match(mcp, /PHONEBASE_MCP_ALLOW_REMOTE/);
  assert.match(mcp, /PHONEBASE_MCP_ALLOW_HOME/);
  assert.match(mcp, /waitedForFinalReceipt/);
  // Frame values are validated by the protocol regression test before images are exposed.
  assert.match(mcp, /INVALID_FRAME_METADATA/);
});

test("publishes a strict, traceable, restart-safe API contract", async () => {
  const [specificationText, controlPlane, contract, installer] = await Promise.all([
    readFile(new URL("../public/openapi.json", import.meta.url), "utf8"),
    readFile(new URL("../agent/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../agent/action-contract.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/install.sh", import.meta.url), "utf8"),
  ]);
  const specification = JSON.parse(specificationText);
  assert.equal(specification.openapi, "3.1.2");
  assert.equal(specification.components.schemas.InputTextAction.properties.text.maxLength, 120);
  assert.deepEqual(
    specification.components.schemas.Availability.properties.supportedKeys.items.enum,
    ["back", "home", "enter"],
  );
  assert.ok(specification.paths["/health"]);
  assert.ok(specification.paths["/api/v1/devices/{deviceId}/calibration"]);
  assert.match(contract, /assertOnlyKeys/);
  assert.match(controlPlane, /action-receipts\.json/);
  assert.match(controlPlane, /audit\.jsonl/);
  assert.match(controlPlane, /PHONEBASE_CONTROL_PLANE_ALLOW_REMOTE/);
  assert.match(controlPlane, /PHONEBASE_CONTROL_PLANE_TOKEN/);
  assert.match(installer, /--no-path/);
  assert.match(installer, /PHONEBASE_ARCHIVE_FILE/);
});

test("ships a dedicated macOS camera permission identity", async () => {
  const [builder, plist, doctor, fleet, cameraBroker] = await Promise.all([
    readFile(new URL("../scripts/build-camera-broker-macos.sh", import.meta.url), "utf8"),
    readFile(new URL("../resources/PhonebaseCameraBroker-Info.plist", import.meta.url), "utf8"),
    readFile(new URL("../scripts/doctor.sh", import.meta.url), "utf8"),
    readFile(new URL("../bridge/fleet_supervisor.ts", import.meta.url), "utf8"),
    readFile(new URL("../bridge/CameraBroker.swift", import.meta.url), "utf8"),
  ]);
  assert.match(builder, /swiftc -O/);
  assert.match(builder, /codesign --force --sign -/);
  assert.match(builder, /--requirements/);
  assert.match(builder, /designated => identifier/);
  assert.match(plist, /ai\.phonebase\.camera-broker/);
  assert.match(plist, /NSCameraUsageDescription/);
  assert.match(doctor, /Privacy & Security → Camera/);
  assert.match(doctor, /exit 1/);
  assert.match(fleet, /cameraBrokerRetryAt = Date\.now\(\) \+ 10_000/);
  assert.match(cameraBroker, /continuousAutoExposure/);
  assert.match(cameraBroker, /CIExposureAdjust/);
});

test("tracks the mouse target and throttles calibrated physical hover movement", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/dashboard-content.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /const trackMouse =/);
  assert.match(page, /mouseTargetRef\.current/);
  assert.match(page, /target\.style\.left/);
  assert.match(page, /window\.addEventListener\("mousemove", handleMouseMove, \{ capture: true/);
  assert.match(page, /type: "hover_move"/);
  assert.match(page, /HOVER_MOVE_INTERVAL_MS = 120/);
  assert.match(page, /device\.capabilities\.actions\.hover_move/);
  assert.match(page, /const localPointerPreview = endpoint\?\.remote !== true/);
  assert.match(page, /const canHover = localPointerPreview/);
  assert.match(page, /if \(!localPointerPreview\)/);
  assert.match(page, /\{localPointerPreview \? \(/);
  assert.match(page, /REMOTE_POLL_INTERVAL_MS = 1_500/);
  assert.match(page, /"Outside screen"/);
  assert.match(page, /onPointerEnter=/);
  assert.match(page, /className={`wall-mouse-target/);
  assert.doesNotMatch(page, /title=\{canTouch \? "Move to preview/);
  assert.match(styles, /\.wall-mouse-target/);
  assert.match(styles, /pointer-events: none/);
});

test("keeps remote focus mode responsive on constrained station links", async () => {
  const [page, liveScreen, gateway, remoteSession] = await Promise.all([
    readFile(new URL("../app/dashboard-content.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/live-screen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../bridge/remote_gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start_remote_session_macos.sh", import.meta.url), "utf8"),
  ]);

  assert.match(page, /focusedDevice \? null : \(/);
  assert.match(page, /quality=\{endpoint.remote \? streamQuality : focusMode \? "focus" : "preview"\}/);
  assert.match(page, /enable-control-badge/);
  assert.match(page, /onControlToggle=\{\(\) => void toggleControl\(\)\}/);
  assert.match(liveScreen, /quality\?: "preview" \| "focus"/);
  assert.match(liveScreen, /flow: "latest"/);
  assert.match(liveScreen, /type: sequence === undefined \? "frame_ready" : "frame_ack"/);
  assert.match(liveScreen, /requestLatestFrame\(drawnSequence\)/);
  assert.doesNotMatch(gateway, /metadata\.role === "verification"/);
  assert.match(gateway, /latestFrameFlow/);
  assert.match(gateway, /queuedLatestFrame/);
  assert.match(gateway, /message\.type === "frame_ack"/);
  assert.match(gateway, /REMOTE_FOCUS_FRAME_WIDTH[\s\S]*?640/);
  assert.match(gateway, /REMOTE_FOCUS_FRAME_QUALITY[\s\S]*?60/);
  assert.match(gateway, /requested\.searchParams\.get\("quality"\) === "focus"/);
  assert.match(gateway, /resize\(\{[\s\S]*?width: Math\.round\(settings\.width\)/);
  assert.match(remoteSession, /PHONEBASE_REMOTE_TUNNEL_PROTOCOL:-quic/);
  assert.match(remoteSession, /--protocol "\$PHONEBASE_TUNNEL_PROTOCOL"/);
  assert.match(remoteSession, /PHONEBASE_TUNNEL_STATE_PATH/);
  assert.match(remoteSession, /\.runtime\/remote-tunnel\.json/);
  assert.match(remoteSession, /\.tunnelId/);
});

test("exposes Hold recovery with truthful resume guidance", async () => {
  const [page, calibration, contract, agent] = await Promise.all([
    readFile(new URL("../app/dashboard-content.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/calibrate/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../agent/action-contract.ts", import.meta.url), "utf8"),
    readFile(new URL("../agent/server.ts", import.meta.url), "utf8"),
  ]);

  assert.match(contract, /\| \{ type: "resume" \}/);
  assert.match(agent, /action: "resume"/);
  assert.match(page, /Resume from Hold/);
  assert.match(calibration, /Resume calibration motion/);
  assert.match(calibration, /controller may continue an interrupted move/);
});

test("guides physical placement before device calibration", async () => {
  const [page, calibration, agent, blackNode] = await Promise.all([
    readFile(new URL("../app/dashboard-content.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/calibrate/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../agent/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../bridge/black_arm_node.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /Position device/);
  assert.match(page, /Four corners inside guide/);
  assert.match(page, /Continue to calibration/);
  assert.match(page, /\/calibrate\?deviceId=/);
  assert.match(page, /<LiveScreen[\s\S]*?raw/);
  assert.match(calibration, /screenHeight: 1560/);
  assert.match(calibration, /operation: "jog"/);
  assert.match(calibration, /Physical camera connected\./);
  assert.match(agent, /Math\.abs\(distance\) > 10/);
  assert.match(agent, /liveFrameMetadata\(stored, raw\)/);
  assert.match(blackNode, /command\.action === "jog"/);
});
