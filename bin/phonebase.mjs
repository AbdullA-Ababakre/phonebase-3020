#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { config as loadEnvironment } from "dotenv";
import { createPhonebaseAccessCode } from "../shared/connection-code.mjs";
import {
  createRentalLease,
  createRentalShortCode,
  createRentalLeaseToken,
  readRentalLeaseRegistry,
  renewRentalLease,
  rentalLeaseActive,
  revokeRentalLease,
  writeRentalLeaseRegistry,
} from "../shared/rental-leases.mjs";
import { SHORT_CODE_GATEWAY } from "../shared/short-access-code.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const environmentFile of [".env.supervisor", ".env.local", ".env"]) {
  loadEnvironment({ path: resolve(ROOT, environmentFile), override: false, quiet: true });
}
const DASHBOARD_URL = "http://127.0.0.1:3020";
const API_URL = "http://127.0.0.1:3013";
const VISION_URL = "http://127.0.0.1:3031";
const CLOUD_CONSOLE_URL = process.env.PHONEBASE_CLOUD_CONSOLE_URL?.trim() ||
  "https://phonebase.co/console";
const INSTALLER_URL = process.env.PHONEBASE_INSTALLER_URL?.trim() ||
  "https://phonebase.co/install.sh";
const SERVICE_MANAGER = resolve(ROOT, "scripts/service-manager-macos.py");
const RENTAL_LEASES_PATH = resolve(
  process.env.PHONEBASE_RENTAL_LEASES_PATH?.trim() || ".runtime/rental-leases.json",
);
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const flags = new Set(args.slice(1));

function run(program, programArgs, options = {}) {
  const result = spawnSync(program, programArgs, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    input: options.input,
    env: { ...process.env, PHONEBASE_API_URL: process.env.PHONEBASE_API_URL ?? API_URL },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${program} exited with status ${result.status ?? "unknown"}`);
  }
  return result;
}

async function runStreaming(program, programArgs) {
  const child = spawn(program, programArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, PHONEBASE_API_URL: process.env.PHONEBASE_API_URL ?? API_URL },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  const code = await new Promise((resolveCode) => child.once("exit", resolveCode));
  process.exitCode = typeof code === "number" ? code : 1;
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function serviceStatus() {
  const [health, vision, devices] = await Promise.all([
    fetchJson(`${API_URL}/health`),
    fetchJson(`${VISION_URL}/health`),
    fetchJson(`${API_URL}/api/v1/devices`),
  ]);
  const deviceList = Array.isArray(devices?.devices) ? devices.devices : [];
  return {
    dashboard: Boolean(await fetch(`${DASHBOARD_URL}/`, {
      signal: AbortSignal.timeout(1_500),
    }).then((response) => response.ok).catch(() => false)),
    controlPlane: health?.ok === true,
    vision: vision?.ok === true,
    deviceCount: deviceList.length,
    connectedDevices: deviceList.filter((device) => device?.connected === true).length,
    touchReadyDevices: deviceList.filter(
      (device) => device?.capabilities?.actions?.tap?.available === true,
    ).length,
    devices: deviceList,
  };
}

function printHelp() {
  process.stdout.write(`Phonebase developer platform

Usage: phonebase <command> [options]

Getting started
  onboard           Check the Mac, install local services, and open setup
  dashboard         Open the local Dashboard
  docs              Open the local developer documentation
  doctor            Check the Dashboard, API, camera, and controller

Operations
  status [--json]   Show local service and device readiness
  start             Start the local background services
  stop              Stop the local background services
  restart           Restart the local background services
  repair            Reinstall dependencies and local services, then verify
  logs [--follow]   Show local service logs
  audit [--json]    Show the latest hardware action audit events
  update            Install the latest published Phonebase build
  uninstall         Stop and remove background services; preserve local data

Developer integration
  mcp               Run the local stdio MCP server
  cloud-link [url]  Create a private one-click Cloud Console pairing link
  cloud-link --copy Copy the private link without printing its token
  agent-guide       Print the complete Agent handoff
  agent-guide --copy
                    Copy the complete Agent handoff to the clipboard

Friend rental beta
  lease create --device <id> --customer <name-or-email> [--copy]
                    Assign one device for one month; --copy copies one access code
  lease list [--json]
                    List active, expired, and revoked rentals
  lease renew <id> [--copy]
                    Extend one month; --copy copies the renewed access code
  lease revoke <id> Revoke renter access immediately

Other
  version           Print the installed version
  help              Show this help

Safety: installation and onboarding never home or move the arm.
`);
}

async function confirm(prompt, expected = "y") {
  if (!process.stdin.isTTY) return false;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question(prompt)).trim().toLowerCase();
    return answer === expected || (expected === "y" && answer === "yes");
  } finally {
    input.close();
  }
}

async function onboard() {
  if (process.platform !== "darwin") {
    throw new Error("Phonebase currently supports macOS only.");
  }
  process.stdout.write(`
Phonebase onboarding
---------------------
This setup installs local services on ports 3020, 3013, and 3031.
It will not home or move the arm.

`);
  if (!flags.has("--prepared")) run("./scripts/setup-macos.sh", []);
  run("python3", [SERVICE_MANAGER, "install"]);

  const deadline = Date.now() + 15_000;
  let state = await serviceStatus();
  while ((!state.dashboard || !state.controlPlane || !state.vision) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    state = await serviceStatus();
  }
  run("./scripts/doctor.sh", [], { allowFailure: true });

  process.stdout.write(`
Software setup is complete.

Next:
1. Connect one Phonebase controller and one UVC camera.
2. Open Connections in the Dashboard.
3. Clear hands, cables, and tools before confirming Home.
4. Choose the phone model once and confirm the detected screen outline.
   Use manual four-point calibration only if recognition asks for it.
5. Use the Dashboard, REST API, or MCP.

Dashboard: ${DASHBOARD_URL}
Docs:      ${DASHBOARD_URL}/docs

`);
  const shouldOpen = !flags.has("--no-open");
  if (shouldOpen) run("open", [DASHBOARD_URL], { allowFailure: true });
}

async function printStatus() {
  const state = await serviceStatus();
  if (flags.has("--json")) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Phonebase status

${state.dashboard ? "✓" : "✗"} Dashboard     ${DASHBOARD_URL}
${state.controlPlane ? "✓" : "✗"} Control API  ${API_URL}
${state.vision ? "✓" : "✗"} Phone Vision ${VISION_URL}
${state.connectedDevices ? "✓" : "!"} Devices      ${state.connectedDevices} connected
${state.touchReadyDevices ? "✓" : "!"} Touch ready  ${state.touchReadyDevices}
`);
}

async function update() {
  const temporary = await mkdtemp(resolve(tmpdir(), "phonebase-update-"));
  const target = resolve(temporary, "install.sh");
  try {
    const response = await fetch(INSTALLER_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Installer download returned HTTP ${response.status}.`);
    await writeFile(target, await response.text(), { mode: 0o700 });
    run("/bin/bash", [target, "--no-onboard"]);
    run("python3", [SERVICE_MANAGER, "restart"]);
    await printStatus();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function showLogs() {
  const logDirectory = resolve(ROOT, ".runtime");
  const files = [
    resolve(logDirectory, "dashboard.log"),
    resolve(logDirectory, "dashboard-error.log"),
    resolve(logDirectory, "control-plane.log"),
    resolve(logDirectory, "control-plane-error.log"),
    resolve(logDirectory, "fleet.log"),
    resolve(logDirectory, "fleet-error.log"),
    resolve(logDirectory, "vision.log"),
    resolve(logDirectory, "vision-error.log"),
  ];
  if (flags.has("--follow")) {
    await runStreaming("tail", ["-n", "100", "-f", ...files]);
  } else {
    run("tail", ["-n", "50", ...files], { allowFailure: true });
    process.stdout.write(`\nLog directory: ${logDirectory}\n`);
  }
}

async function showAudit() {
  const auditPath = resolve(ROOT, "build/runtime/audit.jsonl");
  let entries = [];
  try {
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
    entries = lines.slice(-100).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (flags.has("--json")) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }
  if (entries.length === 0) {
    process.stdout.write("No hardware action audit events have been recorded.\n");
    return;
  }
  for (const entry of entries) {
    process.stdout.write(
      `${entry.at} ${entry.status.padEnd(9)} ${entry.actionType.padEnd(12)} ${entry.deviceId} receipt=${entry.receiptId} actor=${entry.actor}${entry.error ? ` error=${entry.error}` : ""}\n`,
    );
  }
}

async function agentGuide() {
  const guide = await readFile(resolve(ROOT, "public/agent-guide.txt"), "utf8");
  if (flags.has("--copy")) {
    run("pbcopy", [], { input: guide });
    process.stdout.write("Phonebase Agent guide copied to the clipboard.\n");
  } else {
    process.stdout.write(guide);
  }
}

function optionValue(name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  const value = args[index + 1] ?? "";
  return value.startsWith("--") ? "" : value.trim();
}

function remoteAccessSettings(explicitGateway = "") {
  const gatewayValue = explicitGateway ||
    process.env.PHONEBASE_REMOTE_PUBLIC_URL?.trim() || "";
  const secret = process.env.PHONEBASE_LEASE_SIGNING_SECRET?.trim() ||
    process.env.PHONEBASE_REMOTE_TOKEN?.trim() || "";
  if (!gatewayValue) {
    throw new Error(
      "Set PHONEBASE_REMOTE_PUBLIC_URL to the station's approved HTTPS gateway.",
    );
  }
  if (secret.length < 32 || secret.length > 256) {
    throw new Error(
      "PHONEBASE_LEASE_SIGNING_SECRET or PHONEBASE_REMOTE_TOKEN must contain 32 to 256 characters.",
    );
  }
  const gateway = new URL(gatewayValue);
  if (
    gateway.protocol !== "https:" || gateway.username || gateway.password ||
    gateway.search || gateway.hash
  ) {
    throw new Error("The public station gateway must be a clean HTTPS URL.");
  }
  const consoleUrl = new URL(CLOUD_CONSOLE_URL);
  if (consoleUrl.protocol !== "https:") {
    throw new Error("PHONEBASE_CLOUD_CONSOLE_URL must use HTTPS.");
  }
  const allowedOrigins = new Set(
    String(process.env.PHONEBASE_REMOTE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!allowedOrigins.has(consoleUrl.origin)) {
    throw new Error(
      `PHONEBASE_REMOTE_ALLOWED_ORIGINS must include ${consoleUrl.origin}.`,
    );
  }
  return { gateway, consoleUrl, secret };
}

function privateConsoleLink(consoleUrl, accessCode) {
  const link = new URL(consoleUrl);
  link.hash = new URLSearchParams({
    access: accessCode,
  }).toString();
  return link.toString();
}

function leaseStatus(lease, now = new Date()) {
  if (lease.revokedAt) return "revoked";
  return rentalLeaseActive(lease, now) ? "active" : "expired";
}

function printPrivateLeaseAccess(lease, settings, token) {
  const accessCode = settings.gateway.origin === SHORT_CODE_GATEWAY
    ? createRentalShortCode(lease, settings.secret)
    : createPhonebaseAccessCode(settings.gateway.origin, token);
  const consoleLink = privateConsoleLink(
    settings.consoleUrl,
    accessCode,
  );
  if (flags.has("--copy")) {
    run("pbcopy", [], { input: accessCode });
    process.stdout.write(
      `Private one-month access code copied for ${lease.customer}.\n` +
      `Device: ${lease.deviceId}\nExpires: ${lease.expiresAt}\n` +
      "Share it only with that renter.\n",
    );
    return;
  }
  process.stdout.write(`Phonebase monthly rental

Lease ID: ${lease.id}
Customer: ${lease.customer}
Device:   ${lease.deviceId}
Expires:  ${lease.expiresAt}

Private access code:
${accessCode}

One-click Cloud Console:
${consoleLink}

REST / MCP API URL:
${settings.gateway.origin}

Private API token:
${token}

MCP configuration:
${JSON.stringify({
  mcpServers: {
    phonebase: {
      command: "phonebase",
      args: ["mcp"],
      env: {
        PHONEBASE_API_URL: settings.gateway.origin,
        PHONEBASE_API_TOKEN: token,
        PHONEBASE_MCP_ALLOW_REMOTE: "1",
      },
    },
  },
}, null, 2)}

The renter can control only ${lease.deviceId}. Mechanical Home and maintenance are blocked.
`);
}

async function leaseCommand() {
  const operation = args[1] ?? "list";
  if (operation === "list") {
    const registry = await readRentalLeaseRegistry(RENTAL_LEASES_PATH);
    if (flags.has("--json")) {
      process.stdout.write(`${JSON.stringify({
        leases: registry.leases.map((lease) => ({
          ...lease,
          status: leaseStatus(lease),
        })),
      }, null, 2)}\n`);
      return;
    }
    if (!registry.leases.length) {
      process.stdout.write("No rental leases have been created.\n");
      return;
    }
    for (const lease of registry.leases) {
      process.stdout.write(
        `${leaseStatus(lease).padEnd(8)} ${lease.deviceId.padEnd(18)} ` +
        `${lease.customer} expires=${lease.expiresAt} id=${lease.id}\n`,
      );
    }
    return;
  }

  if (operation === "create") {
    const deviceId = optionValue("--device");
    const customer = optionValue("--customer");
    if (!deviceId || !customer) {
      throw new Error("Use lease create --device <id> --customer <name-or-email>.");
    }
    const devicePayload = await fetchJson(
      `${API_URL}/api/v1/devices/${encodeURIComponent(deviceId)}`,
    );
    if (!devicePayload?.device || devicePayload.device.connected !== true) {
      throw new Error(`Device ${deviceId} must be connected before assigning it.`);
    }
    const settings = remoteAccessSettings(optionValue("--gateway"));
    const registry = await readRentalLeaseRegistry(RENTAL_LEASES_PATH);
    const created = createRentalLease(registry, { deviceId, customer, months: 1 });
    await writeRentalLeaseRegistry(RENTAL_LEASES_PATH, created.registry);
    const token = createRentalLeaseToken(created.lease, settings.secret);
    printPrivateLeaseAccess(created.lease, settings, token);
    return;
  }

  if (operation === "renew") {
    const leaseId = args[2]?.startsWith("--") ? "" : args[2]?.trim() ?? "";
    if (!leaseId) throw new Error("Use lease renew <lease-id>.");
    const settings = remoteAccessSettings(optionValue("--gateway"));
    const registry = await readRentalLeaseRegistry(RENTAL_LEASES_PATH);
    const renewed = renewRentalLease(registry, leaseId, 1);
    await writeRentalLeaseRegistry(RENTAL_LEASES_PATH, renewed.registry);
    const token = createRentalLeaseToken(renewed.lease, settings.secret);
    printPrivateLeaseAccess(renewed.lease, settings, token);
    return;
  }

  if (operation === "revoke") {
    const leaseId = args[2]?.startsWith("--") ? "" : args[2]?.trim() ?? "";
    if (!leaseId) throw new Error("Use lease revoke <lease-id>.");
    const registry = await readRentalLeaseRegistry(RENTAL_LEASES_PATH);
    const revoked = revokeRentalLease(registry, leaseId);
    await writeRentalLeaseRegistry(RENTAL_LEASES_PATH, revoked.registry);
    process.stdout.write(
      `Rental access revoked for ${revoked.lease.customer} on ${revoked.lease.deviceId}.\n`,
    );
    return;
  }

  throw new Error(`Unknown lease operation: ${operation}`);
}

async function cloudLink() {
  const explicitGateway = args.slice(1).find((value) => !value.startsWith("--"));
  const token = process.env.PHONEBASE_REMOTE_TOKEN?.trim() ?? "";
  if (token.length < 32 || token.length > 256) {
    throw new Error("PHONEBASE_REMOTE_TOKEN must contain 32 to 256 characters.");
  }
  const settings = remoteAccessSettings(explicitGateway ?? "");
  const accessCode = createPhonebaseAccessCode(settings.gateway.origin, token);
  const value = privateConsoleLink(settings.consoleUrl, accessCode);
  if (flags.has("--copy")) {
    run("pbcopy", [], { input: value });
    process.stdout.write(
      `Private Phonebase Cloud Console link copied for ${settings.gateway.origin}.\n` +
      "It grants physical device control; share it only with an authorized operator.\n",
    );
    return;
  }
  if (flags.has("--open")) {
    run("open", [value]);
    process.stdout.write("Opened the private Phonebase Cloud Console link.\n");
    return;
  }
  process.stdout.write(`${value}\n`);
}

async function uninstall() {
  const approved = flags.has("--yes") || await confirm(
    "Stop and remove Phonebase background services? Local app data will be preserved. [y/N] ",
  );
  if (!approved) {
    process.stdout.write("Uninstall cancelled.\n");
    return;
  }
  run("python3", [SERVICE_MANAGER, "uninstall"]);
  process.stdout.write(`Background services removed. Local files remain in ${ROOT}.\n`);
}

try {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "version":
    case "--version": {
      const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
      process.stdout.write(`${pkg.version}\n`);
      break;
    }
    case "setup":
      run("./scripts/setup-macos.sh", []);
      break;
    case "onboard":
      await onboard();
      break;
    case "dashboard":
      run("open", [DASHBOARD_URL]);
      break;
    case "docs":
      run("open", [`${DASHBOARD_URL}/docs`]);
      break;
    case "doctor":
      run("./scripts/doctor.sh", []);
      break;
    case "status":
      await printStatus();
      break;
    case "start":
    case "stop":
    case "restart":
      run("python3", [SERVICE_MANAGER, command]);
      break;
    case "repair":
      run("./scripts/setup-macos.sh", []);
      run("python3", [SERVICE_MANAGER, "install"]);
      run("./scripts/doctor.sh", [], { allowFailure: true });
      break;
    case "logs":
      await showLogs();
      break;
    case "audit":
      await showAudit();
      break;
    case "update":
      await update();
      break;
    case "uninstall":
      await uninstall();
      break;
    case "mcp":
      await runStreaming("npm", ["run", "--silent", "mcp"]);
      break;
    case "cloud-link":
      await cloudLink();
      break;
    case "lease":
      await leaseCommand();
      break;
    case "agent-guide":
      await agentGuide();
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      printHelp();
      process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`Phonebase: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
