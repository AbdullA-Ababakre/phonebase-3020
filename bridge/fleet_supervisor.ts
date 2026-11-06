import "../shared/station-env.mjs";
import { deviceReconciliation } from "./device-reconciliation";
import { hardwareDiscoveryPolicy, withAutomaticHardwareEnrollment } from "./hardware-discovery-policy";
import { assertLoopbackControlPlaneListener } from "./control-plane-adoption";
import { PendingHardwareDiscoveryRefresh } from "./pending-hardware-discovery-refresh";
import { appendDiscoveredFleetDevices, assertUniqueFleetHardwareBindings, updateFleetConfigurationSync } from "./fleet-configuration-store";
import { fleetDiscoverySnapshot, writeFleetDiscoverySnapshot, type FleetDiscoveryObservation } from "./fleet-discovery-snapshot";
import { CameraProcessPool, type CameraProcessSpec } from "./camera-process-pool";
import { cameraPolicy, selectCameraCaptures, type FleetCameraConfiguration } from "./camera-selection";
import { adoptedProcess, assertStationProcess, listenerPid, matchingProcess, matchingProcessPrefix, processCommand, type ManagedProcess } from "./process-adoption";

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  nextFleetDeviceId,
  normalizeUsbLocation,
  pairUsbHardware,
} from "./fleet_enrollment.ts";

type FleetBinding = {
  id: string;
  serial?: string;
  serialPrefix?: string;
  camera?: string;
  cameraIdentity?: string;
  captureSize?: string;
  captureFps?: number;
  capturePriority?: number;
  cameraRotation?: 0 | 180;
  cameraStreamPort?: number;
  digitalIdentity?: string;
  digitalStreamPort?: number;
  digitalFrameHeight?: number;
  interactiveHoverMs?: number;
  profileId?: string;
  driverPort: number;
};

type FleetDevice = FleetBinding & { serial: string; camera: string };

type ManagedDevice = {
  config: FleetDevice;
  driver: ManagedProcess;
  node: ManagedProcess | null;
  mirror?: ChildProcess;
};

const ROOT = resolve(import.meta.dirname, "..");
// A resumed manager and a station startup must never supervise the same hardware twice.
const OWNER_PATH = resolve(ROOT, ".runtime/fleet-supervisor.json");
mkdirSync(dirname(OWNER_PATH), { recursive: true });
if (existsSync(OWNER_PATH)) {
  const owner = JSON.parse(readFileSync(OWNER_PATH, "utf8")) as { pid: number; command: string };
  const command = processCommand(owner.pid);
  if (command && command === owner.command && command.endsWith(" bridge/fleet_supervisor.ts")) {
    assertStationProcess(owner.pid, ROOT, "bridge/fleet_supervisor.ts");
    console.log(`Fleet manager ${owner.pid} already owns this station; leaving hardware untouched.`);
    process.exit(0);
  }
  unlinkSync(OWNER_PATH);
}
writeFileSync(OWNER_PATH, JSON.stringify({ pid: process.pid, command: processCommand(process.pid) }), { flag: "wx", mode: 0o600 });
process.once("exit", () => {
  try { if (JSON.parse(readFileSync(OWNER_PATH, "utf8")).pid === process.pid) unlinkSync(OWNER_PATH); } catch { /* Another owner or already removed. */ }
});
const CONFIG_PATH = resolve(
  process.env.PHONEBASE_FLEET_CONFIG ?? "config/device-fleet.json",
);
const CALIBRATION_DIRECTORY = resolve(
  process.env.PHONEBASE_CALIBRATION_DIRECTORY ?? "build/devices",
);
const CONTROL_PLANE_PORT = Number(
  process.env.PHONEBASE_CONTROL_PLANE_PORT ?? 3013,
);
const ENROLL_ONLY = process.env.PHONEBASE_FLEET_ENROLL_ONLY === "1";
const CAMERA_BROKER_BINARY = process.env.PHONEBASE_CAMERA_BROKER_BINARY?.trim() ?? "";
const CAMERA_BROKER_APP = process.env.PHONEBASE_CAMERA_BROKER_APP?.trim() ?? "";
const ADOPT_RUNNING = process.env.PHONEBASE_FLEET_ADOPT_RUNNING !== "0";
const managed = new Map<string, ManagedDevice>();
let controlPlane: ManagedProcess | null = null;
const cameraPool = new CameraProcessPool((spec) => {
  if (ADOPT_RUNNING) {
    const pid = matchingProcess([spec.command, ...spec.args].join(" "));
    if (pid) {
      console.log(`Adopting existing camera capture for ${spec.id} (${pid})`);
      return adoptedProcess(pid);
    }
    const previous = matchingProcessPrefix([spec.command, ...spec.args.slice(0, 4)].join(" ") + " ");
    if (previous) {
      adoptedProcess(previous).kill("SIGTERM");
      throw new Error(`${spec.id} capture configuration changed; waiting for the previous capture to close.`);
    }
  }
  console.log(`Starting independent camera capture for ${spec.id}`);
  const capture = child(spec.command, spec.args, {});
  // The native watchdog handles frame starvation; the pool handles exits.
  return capture;
}, Date.now, 3_000);
let cameraResolutionRetryAt = 0;
let pendingHardwareDiscovery = false;
let automaticHardwareEnrollment = true;
let lastDiscoveryObservation: FleetDiscoveryObservation | null = null;
const discoveryRefresh = new PendingHardwareDiscoveryRefresh();
const DISCOVERY_PATH = resolve(process.env.PHONEBASE_FLEET_DISCOVERY_PATH ?? "build/runtime/fleet-discovery.json");
let stopped = false;

function safeDevice(value: unknown, index: number): FleetBinding {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const id = String(input.id ?? "").trim();
  const serial = String(input.serial ?? "").trim();
  const serialPrefix = String(input.serialPrefix ?? "").trim();
  const camera = String(input.camera ?? "").trim();
  const cameraIdentity = String(input.cameraIdentity ?? "").trim();
  const captureSize = String(input.captureSize ?? "").trim();
  const captureFps = Number(input.captureFps ?? 0);
  const capturePriority = Number(input.capturePriority ?? 0);
  if (!Number.isInteger(capturePriority) || capturePriority < 0 || capturePriority > 100) throw new Error(`Invalid camera priority for ${id}`);
  const cameraRotation = Number(input.cameraRotation ?? 0);
  const cameraStreamPort = Number(input.cameraStreamPort ?? 0);
  const digitalIdentity = String(input.digitalIdentity ?? "").trim();
  const digitalStreamPort = Number(input.digitalStreamPort ?? 0);
  const digitalFrameHeight = Number(input.digitalFrameHeight ?? 1560);
  const interactiveHoverMs = Number(input.interactiveHoverMs ?? 0);
  if (![1280, 1560].includes(digitalFrameHeight)) throw new Error(`Unsupported mirror height for ${id}`);
  if (digitalIdentity && (!Number.isInteger(digitalStreamPort) || digitalStreamPort < 3000 || digitalStreamPort > 65535)) throw new Error(`Invalid mirror port for ${id}`);
  if (!Number.isInteger(interactiveHoverMs) || (interactiveHoverMs !== 0 && (interactiveHoverMs < 500 || interactiveHoverMs > 5_000))) {
    throw new Error(`Invalid interactive hover timeout for ${id}`);
  }
  const profileId = String(input.profileId ?? "").trim();
  const driverPort = Number(input.driverPort ?? 3014 + index);
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(id)) throw new Error(`Invalid device id at index ${index}`);
  if (!serial && !serialPrefix) throw new Error(`Serial identity is required for ${id}`);
  if (serial && !serial.startsWith("/dev/cu.")) throw new Error(`Invalid serial path for ${id}`);
  if (serialPrefix && !serialPrefix.startsWith("/dev/cu.usbserial-")) {
    throw new Error(`Invalid serial prefix for ${id}`);
  }
  if (!camera && !cameraIdentity) throw new Error(`Camera identity is required for ${id}`);
  if (captureSize && !new Set(["640x360", "640x480", "1280x720", "1920x1080"]).has(captureSize)) {
    throw new Error(`Invalid camera capture size for ${id}`);
  }
  if (captureFps && !new Set([5, 15, 30]).has(captureFps)) {
    throw new Error(`Invalid camera capture frame rate for ${id}`);
  }
  if (cameraRotation !== 0 && cameraRotation !== 180) {
    throw new Error(`Invalid camera rotation for ${id}; expected 0 or 180`);
  }
  if (
    cameraStreamPort &&
    (!Number.isInteger(cameraStreamPort) || cameraStreamPort < 3_000 || cameraStreamPort > 65_535)
  ) {
    throw new Error(`Invalid camera stream port for ${id}`);
  }
  if (!Number.isInteger(driverPort) || driverPort < 3014 || driverPort > 3999) {
    throw new Error(`Invalid driver port for ${id}`);
  }
  return {
    id,
    ...(serial ? { serial } : {}),
    ...(serialPrefix ? { serialPrefix } : {}),
    ...(camera ? { camera } : {}),
    ...(cameraIdentity ? { cameraIdentity } : {}),
    ...(captureSize ? { captureSize } : {}),
    ...(captureFps ? { captureFps } : {}),
    ...(capturePriority ? { capturePriority } : {}),
    ...(cameraRotation ? { cameraRotation: cameraRotation as 180 } : {}),
    ...(cameraStreamPort ? { cameraStreamPort } : {}),
    ...(digitalIdentity ? { digitalIdentity, digitalStreamPort, digitalFrameHeight } : {}),
    ...(interactiveHoverMs ? { interactiveHoverMs } : {}),
    ...(profileId ? { profileId } : {}),
    driverPort,
  };
}

function validatedConfiguredDevices(parsed: { devices?: unknown[] }): FleetBinding[] {
  cameraPolicy(parsed as FleetCameraConfiguration);
  hardwareDiscoveryPolicy(parsed as FleetCameraConfiguration);
  const devices = (parsed.devices ?? []).map(safeDevice);
  const ids = new Set<string>();
  const ports = new Set<number>();
  const cameraStreamPorts = new Set<number>();
  const mirrorIdentities = new Set<string>();
  for (const device of devices) {
    if (ids.has(device.id)) throw new Error(`Duplicate device id: ${device.id}`);
    if (ports.has(device.driverPort)) throw new Error(`Duplicate driver port: ${device.driverPort}`);
    if (device.cameraStreamPort && cameraStreamPorts.has(device.cameraStreamPort)) {
      throw new Error(`Duplicate camera stream port: ${device.cameraStreamPort}`);
    }
    if (device.digitalIdentity) {
      if (mirrorIdentities.has(device.digitalIdentity)) throw new Error("An iPhone mirror cannot be assigned to multiple devices");
      mirrorIdentities.add(device.digitalIdentity);
    }
    if (device.digitalStreamPort) {
      if (device.digitalStreamPort === device.cameraStreamPort || cameraStreamPorts.has(device.digitalStreamPort)) throw new Error("Duplicate mirror stream port");
      cameraStreamPorts.add(device.digitalStreamPort);
    }
    ids.add(device.id);
    ports.add(device.driverPort);
    if (device.cameraStreamPort) cameraStreamPorts.add(device.cameraStreamPort);
  }
  assertUniqueFleetHardwareBindings(devices);
  return devices;
}

function configuredDevices(): FleetBinding[] {
  if (!existsSync(CONFIG_PATH)) return [];
  return validatedConfiguredDevices(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
}

function persistConfiguredDevices(expectedBindings: FleetBinding[], additions: FleetBinding[]) {
  updateFleetConfigurationSync(CONFIG_PATH, current => {
    const currentBindings = validatedConfiguredDevices(current);
    // Keep the latest raw device objects and top-level policy. Discovery can
    // append new unconfigured hardware, never overwrite an existing identity.
    return appendDiscoveredFleetDevices(current, expectedBindings, currentBindings, additions);
  }, validatedConfiguredDevices);
}

function observedSystemCameras() { return lastDiscoveryObservation?.cameras; }

function publishDiscoverySnapshot(bindings: FleetBinding[], assignments: Map<string, string>) {
  if (!lastDiscoveryObservation) return;
  try { writeFleetDiscoverySnapshot(DISCOVERY_PATH, fleetDiscoverySnapshot(bindings, lastDiscoveryObservation, assignments, pendingHardwareDiscovery, Date.now(), automaticHardwareEnrollment)); }
  catch (error) { console.error("Could not publish fleet discovery diagnostics:", error instanceof Error ? error.message : error); }
}

function detectedSerials() {
  const result = spawnSync("zsh", ["-c", "print -rl -- /dev/cu.usbserial-*(N)"], {
    encoding: "utf8",
  });
  return result.stdout.split("\n").map((value) => value.trim()).filter(Boolean).sort();
}

function detectedCameras() {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", "",
  ], { encoding: "utf8" });
  const output = `${result.stdout}\n${result.stderr}`;
  const videoSection = output.split("AVFoundation audio devices:")[0] ?? output;
  return [...videoSection.matchAll(/\[(\d+)\]\s+([^\r\n]+)/g)]
    .map((match) => ({ index: match[1], name: match[2].trim() }))
    .filter((camera) => /USB Camera/i.test(camera.name));
}

function detectedSystemCameras() {
  const source = [
    "import AVFoundation",
    "for (index, device) in AVCaptureDevice.devices(for: .video).enumerated() {",
    "  print(\"\\(index)\\t\\(device.localizedName)\\t\\(device.uniqueID)\")",
    "}",
  ].join("\n");
  const commandLineTools = "/Library/Developer/CommandLineTools";
  const developerDirectory = process.env.DEVELOPER_DIR?.trim() ||
    (existsSync(`${commandLineTools}/usr/bin/swift`) ? commandLineTools : "");
  const result = spawnSync("swift", ["-e", source], {
    encoding: "utf8",
    env: developerDirectory
      ? { ...process.env, DEVELOPER_DIR: developerDirectory }
      : process.env,
  });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").flatMap((line) => {
    const [index, name, uniqueId] = line.trim().split("\t");
    return /^\d+$/.test(index ?? "") && name && uniqueId
      ? [{ index, name, uniqueId }]
      : [];
  });
}

function detectedUsbCameraLocations() {
  const result = spawnSync("ioreg", ["-p", "IOUSB", "-w0"], { encoding: "utf8" });
  return [...result.stdout.matchAll(/USB Camera2@([0-9a-f]+)/gi)]
    .map((match) => normalizeUsbLocation(match[1]))
    .sort();
}

function detectedUsbSerialLocations() {
  const result = spawnSync("ioreg", ["-p", "IOUSB", "-w0"], { encoding: "utf8" });
  return [...result.stdout.matchAll(/USB Serial@([0-9a-f]+)/gi)]
    .map((match) => normalizeUsbLocation(match[1]))
    .sort();
}

function controllerLocation(serial: string, locations: string[]) {
  const suffix = serial.replace(/^.*usbserial-/, "").toLowerCase().replace(/^0+/, "");
  const matches = locations.filter((location) => {
    const candidate = location.replace(/^0+/, "");
    return candidate === suffix ||
      candidate.replace(/0+$/, "") === suffix.replace(/0+$/, "");
  });
  return matches.length === 1 ? matches[0] : "";
}

function cameraLocation(identity: string, locations: string[]) {
  const normalizedIdentity = identity.toLowerCase().replace(/^0x/, "");
  const matches = locations.filter((location) =>
    normalizedIdentity.startsWith(location.replace(/^0+/, ""))
  );
  return matches.length === 1 ? matches[0] : "";
}

function resolveCameraAssignments(bindings: FleetBinding[], systemCameras = detectedSystemCameras()) {
  const assignments = new Map<string, string>();
  const avCameras = detectedCameras();
  for (const binding of bindings) {
    if (binding.cameraIdentity) {
      const prefix = binding.cameraIdentity.toLowerCase();
      const matches = systemCameras.filter((camera) =>
        camera.uniqueId.toLowerCase().startsWith(prefix)
      );
      if (matches.length !== 1) {
        console.warn(
          `${binding.id} camera identity matched ${matches.length} devices; keeping it locked.`,
        );
        continue;
      }
      const identity = matches[0];
      const camera = avCameras.find((candidate) => candidate.index === identity.index);
      if (
        !camera ||
        camera.name !== identity.name ||
        !/^USB Camera2$/i.test(camera.name)
      ) {
        console.warn(`${binding.id} camera identity did not resolve to a robot USB camera.`);
        continue;
      }
      assignments.set(binding.id, camera.index);
      console.log(
        `Resolved ${binding.id} camera ${binding.cameraIdentity} -> AVFoundation ${camera.index}`,
      );
    } else if (binding.camera) {
      assignments.set(binding.id, binding.camera);
    }
  }
  return assignments;
}

function hardwareSignature() {
  const result = spawnSync("ioreg", ["-p", "IOUSB", "-w0"], { encoding: "utf8" });
  const cameraLocations = [...result.stdout.matchAll(/USB Camera2@([0-9a-f]+)/gi)]
    .map((match) => match[1].toLowerCase())
    .sort();
  return JSON.stringify({ serials: detectedSerials(), cameraLocations,
    configVersion: existsSync(CONFIG_PATH) ? statSync(CONFIG_PATH).mtimeMs : 0 });
}

function bindingClaimsSerial(binding: FleetBinding, serial: string) {
  return binding.serial === serial || Boolean(
    binding.serialPrefix && serial.startsWith(binding.serialPrefix),
  );
}

function bindingClaimsCamera(binding: FleetBinding, uniqueId: string) {
  return Boolean(
    binding.cameraIdentity &&
    uniqueId.toLowerCase().startsWith(binding.cameraIdentity.toLowerCase()),
  );
}

function withSafelyDiscoveredDevices(bindings: FleetBinding[]) {
  const policy = hardwareDiscoveryPolicy(existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {});
  automaticHardwareEnrollment = policy.automaticEnrollment;
  pendingHardwareDiscovery = false;
  const serials = detectedSerials();
  const systemCameras = detectedSystemCameras();
  lastDiscoveryObservation = { observedAt: Date.now(), serials, cameras: systemCameras };
  const unclaimedSerials = serials.filter((serial) =>
    !bindings.some((binding) => bindingClaimsSerial(binding, serial))
  );
  const serialLocations = detectedUsbSerialLocations();
  const cameraLocations = detectedUsbCameraLocations();
  const unclaimedCameras = systemCameras.filter((camera) =>
    /^USB Camera2$/i.test(camera.name) &&
    !bindings.some((binding) => bindingClaimsCamera(binding, camera.uniqueId)) &&
    Boolean(cameraLocation(camera.uniqueId, cameraLocations))
  );
  if (!unclaimedSerials.length && !unclaimedCameras.length) return bindings;
  if (unclaimedSerials.length !== unclaimedCameras.length) {
    pendingHardwareDiscovery = true;
    console.warn(
      `Unpaired discovery found ${unclaimedSerials.length} controller(s) and ` +
      `${unclaimedCameras.length} camera(s); waiting for complete hardware pairs.`,
    );
    return bindings;
  }

  const pairs = pairUsbHardware(
    unclaimedSerials.map((serial) => ({
      serial,
      location: controllerLocation(serial, serialLocations),
    })).filter((controller) => Boolean(controller.location)),
    unclaimedCameras.map((camera) => ({
      identity: camera.uniqueId,
      location: cameraLocation(camera.uniqueId, cameraLocations),
    })),
  );
  if (pairs.length !== unclaimedSerials.length) {
    pendingHardwareDiscovery = true;
    console.warn("USB topology pairing was incomplete; keeping new hardware locked.");
    return bindings;
  }

  const enrollment = withAutomaticHardwareEnrollment(policy, bindings, () => {
    const preferredPrefix = process.env.PHONEBASE_STATION_DEVICE_PREFIX?.trim() ||
      bindings.map((binding) => binding.id.match(/^(.*black-arm)-\d+$/)?.[1]).find(Boolean) ||
      "black-arm";
    const ids = new Set(bindings.map((binding) => binding.id));
    const usedPorts = new Set(bindings.flatMap((binding) => [
      binding.driverPort,
      binding.cameraStreamPort ?? 0,
      binding.digitalStreamPort ?? 0,
    ]).filter(Boolean));
    for (const port of [
      CONTROL_PLANE_PORT,
      Number(process.env.PHONEBASE_REMOTE_PORT ?? 3015),
      Number(process.env.PHONEBASE_SUPERVISOR_PORT ?? 3016),
      Number(process.env.PHONEBASE_CONSOLE_PORT ?? 3020),
      3021, // Legacy public Console origin; never allocate to a hardware driver.
      3040, // Read-only public Console frontend, kept separate from operator UI.
      Number(process.env.PHONEBASE_AUTO_SETUP_PORT ?? 3031),
    ]) usedPorts.add(port);

    const allocatePort = (start: number) => {
      let port = start;
      while (usedPorts.has(port)) port += 1;
      usedPorts.add(port);
      return port;
    };
    const configuredRotation = Number(process.env.PHONEBASE_STATION_CAMERA_ROTATION ??
      bindings.find((binding) => binding.cameraRotation !== undefined)?.cameraRotation ?? 0);
    const stationCameraRotation = configuredRotation === 180 ? 180 : 0;
    const discovered = pairs.map((pair) => {
      const id = nextFleetDeviceId(ids, preferredPrefix);
      ids.add(id);
      const device: FleetBinding = {
        id,
        serial: pair.controller.serial,
        cameraIdentity: pair.camera.identity,
        captureSize: "640x480",
        captureFps: 30,
        ...(stationCameraRotation ? { cameraRotation: stationCameraRotation as 180 } : {}),
        cameraStreamPort: allocatePort(3111),
        profileId: "unconfigured",
        driverPort: allocatePort(3014),
      };
      console.log(
        `Auto-enrolled ${device.id}: ${device.serial} + ${device.cameraIdentity} ` +
        `(USB affinity ${pair.affinity}); setup remains locked until Home and calibration.`,
      );
      return device;
    });
    const enrolled = [...bindings, ...discovered];
    persistConfiguredDevices(bindings, discovered);
    console.log(
      `Persisted ${discovered.length} new device binding(s) to ${CONFIG_PATH}.`,
    );
    return enrolled;
  });
  if (enrollment.paused) {
    pendingHardwareDiscovery = true;
    console.warn("Automatic hardware enrollment is paused; verify the physical stand label and bind its controller/camera before adding or moving a station.");
  }
  return enrollment.bindings;
}

function child(command: string, args: string[], environment: Record<string, string>) {
  const commandLineTools = "/Library/Developer/CommandLineTools";
  const developerDirectory = process.env.DEVELOPER_DIR?.trim() ||
    (existsSync(`${commandLineTools}/usr/bin/python3`) ? commandLineTools : "");
  return spawn(command, args, {
    cwd: ROOT,
    env: {
      ...globalThis.process.env,
      ...(developerDirectory ? { DEVELOPER_DIR: developerDirectory } : {}),
      ...environment,
    },
    stdio: "inherit",
  });
}

async function waitForDriver(port: number) {
  for (let attempt = 0; attempt < 50 && !stopped; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(300),
      });
      if (response.ok) return true;
    } catch {
      // The driver may still be negotiating its serial port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return false;
}

function nodeEnvironment(config: FleetDevice): Record<string, string> {
  return {
    PHONEBASE_BLACK_AUTO_HOME: "0",
    ...(config.digitalStreamPort ? { PHONEBASE_DIGITAL_STREAM_PORT: String(config.digitalStreamPort), PHONEBASE_DIGITAL_FRAME_HEIGHT: String(config.digitalFrameHeight ?? 1560) } : {}),
    PHONEBASE_BLACK_DEVICE_ID: config.id,
    PHONEBASE_BLACK_DRIVER_URL: `http://127.0.0.1:${config.driverPort}`,
    PHONEBASE_BLACK_INTERACTIVE_HOVER_MS: String(config.interactiveHoverMs ?? 0),
    PHONEBASE_BLACK_CAMERA: config.camera,
    ...(config.cameraIdentity
      ? { PHONEBASE_BLACK_CAMERA_IDENTITY: config.cameraIdentity }
      : {}),
    ...(config.cameraIdentity ? { PHONEBASE_BLACK_CAMERA_RESOLVED: "1" } : {}),
    ...(config.captureSize ? { PHONEBASE_BLACK_CAPTURE_SIZE: config.captureSize } : {}),
    ...(config.captureFps
      ? { PHONEBASE_BLACK_CAPTURE_FPS: String(config.captureFps) }
      : {}),
    ...(config.cameraStreamPort
      ? { PHONEBASE_BLACK_CAMERA_STREAM_PORT: String(config.cameraStreamPort) }
      : {}),
    ...(config.profileId ? { PHONEBASE_BLACK_PROFILE_ID: config.profileId } : {}),
  };
}

async function startDevice(config: FleetDevice) {
  if (managed.has(config.id) || !existsSync(config.serial)) return;
  if (ADOPT_RUNNING) {
    const driverPid = listenerPid(config.driverPort);
    const nodePid = config.cameraStreamPort ? listenerPid(config.cameraStreamPort) : null;
    if (nodePid && !driverPid) throw new Error(`${config.id} has a node without its expected driver.`);
    if (driverPid) {
      assertStationProcess(driverPid, ROOT, "bridge/black_arm_driver.py", config.serial);
      const response = await fetch(`http://127.0.0.1:${config.driverPort}/api/status`, { signal: AbortSignal.timeout(3_000) });
      const status = await response.json() as { port?: string; connected?: boolean };
      if (!response.ok || status.port !== config.serial || !status.connected) {
        throw new Error(`${config.id} driver identity or connection could not be verified.`);
      }
      if (nodePid) assertStationProcess(nodePid, ROOT, "bridge/black_arm_node.ts");
      const driver = adoptedProcess(driverPid);
      const entry: ManagedDevice = { config, driver,
        node: nodePid ? adoptedProcess(nodePid) : child("npm", ["run", "black:node"], nodeEnvironment(config)) };
      managed.set(config.id, entry);
      driver.once("exit", () => { entry.node?.kill("SIGTERM"); entry.mirror?.kill("SIGTERM"); managed.delete(config.id); });
      entry.node!.once("exit", () => { entry.node = null; });
      console.log(`Adopted ${config.id} driver ${driverPid}${nodePid ? ` and node ${nodePid}` : ""}; homing state retained by driver.`);
      return;
    }
  }
  console.log(
    `Connecting ${config.id}: ${config.serial} + camera ${config.cameraIdentity ?? config.camera}`,
  );
  const driver = child("python3", ["bridge/black_arm_driver.py"], {
    PHONEBASE_BLACK_SERIAL: config.serial,
    PHONEBASE_BLACK_PORT: String(config.driverPort),
    PHONEBASE_BLACK_MAINTENANCE: "0",
    PHONEBASE_BLACK_RESTORE_MANUAL_REFERENCE: "0",
    PHONEBASE_BLACK_INTERACTIVE_HOVER_MS: String(config.interactiveHoverMs ?? 0),
  });
  const entry: ManagedDevice = { config, driver, node: null };
  managed.set(config.id, entry);
  driver.once("exit", () => {
    entry.node?.kill("SIGTERM");
    entry.mirror?.kill("SIGTERM");
    managed.delete(config.id);
  });
  if (!await waitForDriver(config.driverPort) || stopped) {
    driver.kill("SIGTERM");
    return;
  }
  entry.node = child("npm", ["run", "black:node"], nodeEnvironment(config));
  entry.node.once("exit", () => { entry.node = null; entry.mirror?.kill("SIGTERM"); });
  // The video node owns mirror capture and retries on every startup path,
  // including adopted drivers and node-only restarts.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
}

function resolvedDevice(
  binding: FleetBinding,
  cameraAssignments: Map<string, string>,
): FleetDevice | null {
  const camera = cameraAssignments.get(binding.id);
  if (!camera) return null;
  if (binding.serial) {
    return existsSync(binding.serial) ? { ...binding, serial: binding.serial, camera } : null;
  }
  const matches = detectedSerials().filter((serial) => serial.startsWith(binding.serialPrefix!));
  if (matches.length !== 1) {
    if (matches.length > 1) {
      console.warn(`${binding.id} serial identity matched ${matches.length} devices; keeping it locked.`);
    }
    return null;
  }
  return { ...binding, serial: matches[0], camera };
}

async function stopMissingDevices(devices: FleetDevice[]) {
  const resolved = new Map(devices.map((device) => [device.id, device]));
  for (const [id, entry] of managed) {
    const current = resolved.get(id);
    const change = deviceReconciliation(entry.config, current, existsSync(entry.config.serial));
    if (change === "retain") continue;
    if (change === "replace-node" && current) {
      // A local operator explicitly rebound the same controller to its moved
      // camera. Wait until motion finishes, then replace only the video node.
      // The original driver retains its real in-memory homing reference.
      const response = await fetch(`http://127.0.0.1:${entry.config.driverPort}/api/status`, {
        signal: AbortSignal.timeout(1_000),
      });
      const status = await response.json() as { port?: string; connected?: boolean; state?: string; active_operation?: unknown };
      if (!response.ok || status.port !== entry.config.serial || !status.connected) throw new Error(`${id} controller identity could not be verified during camera rebind.`);
      if (status.active_operation || !["Idle", "Alarm"].includes(status.state ?? "")) continue;
      const nodePid = entry.config.cameraStreamPort ? listenerPid(entry.config.cameraStreamPort) : null;
      if (nodePid) {
        assertStationProcess(nodePid, ROOT, "bridge/black_arm_node.ts");
        adoptedProcess(nodePid).kill("SIGTERM");
      } else {
        entry.node?.kill("SIGTERM");
      }
      entry.mirror?.kill("SIGTERM");
      if (entry.node) {
        await new Promise<void>((resolvePromise, reject) => {
          const timeout = setTimeout(() => reject(new Error(`${id} old video node has not exited; preserving its controller.`)), 4_000);
          entry.node!.once("exit", () => { clearTimeout(timeout); resolvePromise(); });
        });
      }
      if (entry.config.cameraStreamPort && listenerPid(entry.config.cameraStreamPort)) throw new Error(`${id} old video listener remains; refusing a duplicate node.`);
      entry.node = null;
      entry.config = current;
      console.log(`${id} camera rebound; original controller and homing state retained.`);
      continue;
    }
    console.log(`${id} disconnected or USB identity changed`);
    entry.node?.kill("SIGTERM");
    entry.driver.kill("SIGTERM");
    managed.delete(id);
  }
}

async function reconcile(
  bindings: FleetBinding[],
  cameraAssignments: Map<string, string>,
) {
  const configs = bindings
    .map((binding) => resolvedDevice(binding, cameraAssignments))
    .filter((device): device is FleetDevice => device !== null);
  await stopMissingDevices(configs);
  for (const config of configs) {
    const entry = managed.get(config.id);
    if (!entry) {
      await startDevice(config);
    } else if (!entry.node && existsSync(config.serial)) {
      entry.node = child("npm", ["run", "black:node"], nodeEnvironment(config));
      entry.node.once("exit", () => { entry.node = null; });
    }
  }
  // A rebind deferred by active motion must not send the newly selected
  // camera into a node that still declares the old camera identity.
  return configs.filter(config => {
    const entry = managed.get(config.id);
    return entry && deviceReconciliation(entry.config, config, true) === "retain";
  });
}

function stopNativeBrokers(mirror: boolean) {
  if (!CAMERA_BROKER_APP) return;
  const executable = resolve(CAMERA_BROKER_APP, "Contents/MacOS/PhonebaseCameraBroker");
  const processes = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  for (const line of processes.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || !match[2].startsWith(`${executable} --camera `)) continue;
    if (match[2].includes(" --camera iphone:") !== mirror) continue;
    try { process.kill(Number(match[1]), "SIGTERM"); } catch { /* Already exited. */ }
  }
}

function stopCameraBroker() {
  cameraPool.stop();
}

function startCameraBroker(configs: FleetDevice[]) {
  const configuration = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FleetCameraConfiguration;
  const specs: CameraProcessSpec[] = selectCameraCaptures(configs, cameraPolicy(configuration))
    .filter(config => config.cameraStreamPort && config.cameraIdentity && managed.get(config.id)?.node)
    .map(config => {
      const [width, height] = (config.captureSize ?? "640x480").split("x");
      // Run the signed executable directly so shutdown owns the real process.
      const executable = CAMERA_BROKER_APP
        ? resolve(CAMERA_BROKER_APP, "Contents/MacOS/PhonebaseCameraBroker")
        : CAMERA_BROKER_BINARY || "swift";
      const args = [
        ...(executable === "swift" ? [resolve(ROOT, "bridge/CameraBroker.swift")] : []),
        "--camera", config.cameraIdentity!, "--port", String(config.cameraStreamPort),
        "--width", width, "--height", height,
        "--fps", String(config.captureFps ?? 30),
        "--rotation", String(config.cameraRotation ?? 0),
      ];
      return { id: config.id, signature: JSON.stringify([executable, args]), command: executable, args };
    });
  cameraPool.reconcile(specs);
}

function stopManagedDevices() {
  stopCameraBroker();
  stopNativeBrokers(true);
  for (const entry of managed.values()) {
    entry.node?.kill("SIGTERM");
    entry.driver.kill("SIGTERM");
  }
  managed.clear();
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  stopManagedDevices();
  controlPlane?.kill("SIGTERM");
  setTimeout(() => globalThis.process.exit(0), 500).unref();
}

// A recovered manager remains part of the station lifecycle, even when its
// original parent exited. Stopping the station must also stop its fleet.
const stationOwnerPid = Number(process.env.PHONEBASE_FLEET_OWNER_PID ?? 0);
if (Number.isInteger(stationOwnerPid) && stationOwnerPid > 1) {
  const ownerCommand = processCommand(stationOwnerPid);
  if (!ownerCommand.endsWith(` ${resolve(ROOT, "start-local.sh")}`)) throw new Error("Invalid station owner process.");
  setInterval(() => {
    try { if (processCommand(stationOwnerPid) === ownerCommand) return; } catch { return; }
    console.log("Station owner stopped; shutting down its recovered fleet.");
    shutdown();
  }, 1_000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  globalThis.process.on(signal, shutdown);
}

if (!ENROLL_ONLY && process.env.PHONEBASE_FLEET_START_CONTROL_PLANE !== "0") {
  const existingControlPlanePid = ADOPT_RUNNING ? listenerPid(CONTROL_PLANE_PORT) : null;
  if (existingControlPlanePid) {
    assertStationProcess(existingControlPlanePid, ROOT, "agent/server.ts");
    const listeners = spawnSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(existingControlPlanePid), `-iTCP:${CONTROL_PLANE_PORT}`, "-sTCP:LISTEN", "-Fn"], { encoding: "utf8", timeout: 3_000 });
    if (listeners.error) throw listeners.error;
    assertLoopbackControlPlaneListener(listeners.stdout, CONTROL_PLANE_PORT);
    controlPlane = adoptedProcess(existingControlPlanePid);
    console.log(`Adopted existing control plane ${existingControlPlanePid}; hardware connections retained.`);
  } else controlPlane = child("npm", ["run", "control-plane"], {
    PHONEBASE_CONTROL_PLANE_PORT: String(CONTROL_PLANE_PORT),
    PHONEBASE_CALIBRATION_DIRECTORY: CALIBRATION_DIRECTORY,
    // A fleet station must never inherit the repository's legacy single-arm
    // calibration. Device-specific profiles are loaded only from the ignored
    // calibration directory after they have been verified on this station.
    PHONEBASE_CALIBRATION_PATH: "",
  });
}

// Launchd can terminate the supervisor before its app children have exited.
// Remove only this installation's orphaned capture processes before binding ports.
// Validate configuration before touching any running hardware.
let configured = configuredDevices();
if (!ADOPT_RUNNING) { stopNativeBrokers(false); stopNativeBrokers(true); }
const initialHardwareSignature = hardwareSignature();
let devices = withSafelyDiscoveredDevices(configured);
if (devices.length !== configured.length) configured = configuredDevices();
console.log(
  configured.length
    ? `Loaded ${configured.length} device binding(s) from ${CONFIG_PATH}`
    : "No complete controller/camera pairs are available for enrollment.",
);
if (ENROLL_ONLY) process.exit(0);
let cameraAssignments = resolveCameraAssignments(devices, observedSystemCameras());
discoveryRefresh.settled(initialHardwareSignature, pendingHardwareDiscovery, Date.now());
publishDiscoverySnapshot(devices, cameraAssignments);
let reconcileActive = false;
startCameraBroker(await reconcile(devices, cameraAssignments));
setInterval(() => {
  if (stopped || reconcileActive) return;
  reconcileActive = true;
  void (async () => {
    const currentSignature = hardwareSignature();
    if (discoveryRefresh.shouldRefresh(currentSignature, Date.now())) {
      console.log("Device connections or capture configuration changed; resolving physical identities.");
      // AVFoundation can publish a camera after its USB node appears. Retry a
      // pending pair even when the raw USB signature has stopped changing.
      // Resolve membership without restarting healthy cameras or controllers.
      // The capture pool reconciles only added/removed/changed identities.
      configured = configuredDevices();
      devices = withSafelyDiscoveredDevices(configured);
      if (devices.length !== configured.length) configured = configuredDevices();
      cameraAssignments = resolveCameraAssignments(devices, observedSystemCameras());
      // Commit the pre-discovery signature. A USB/config change during queries
      // must be reconsidered on the next tick, rather than silently consumed.
      discoveryRefresh.settled(currentSignature, pendingHardwareDiscovery, Date.now());
      publishDiscoverySnapshot(devices, cameraAssignments);
    }
    const connectedSerials = detectedSerials();
    const unresolvedConnectedCamera = devices.some((binding) => {
      const controllerConnected = binding.serial
        ? connectedSerials.includes(binding.serial)
        : connectedSerials.some((serial) => serial.startsWith(binding.serialPrefix!));
      return controllerConnected && !cameraAssignments.has(binding.id);
    });
    if (unresolvedConnectedCamera && Date.now() >= cameraResolutionRetryAt) {
      // AVFoundation can briefly return no cameras while a broker from the
      // previous Fleet process is closing. Retry identities without requiring
      // the customer to unplug/replug otherwise healthy USB hardware.
      cameraAssignments = resolveCameraAssignments(devices);
      cameraResolutionRetryAt = Date.now() + 5_000;
    }
    const configs = await reconcile(devices, cameraAssignments);
    startCameraBroker(configs);
  })().catch(error => {
    console.error("Fleet reconciliation failed; keeping existing controllers and captures running:", error instanceof Error ? error.message : error);
  }).finally(() => { reconcileActive = false; });
}, 1_500);
