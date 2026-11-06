import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cameraPolicy, type FleetCameraConfiguration } from "./camera-selection";
import { hardwareDiscoveryPolicy } from "./hardware-discovery-policy";

type ConfigurationTransform = (current: FleetCameraConfiguration) => FleetCameraConfiguration;
type ConfigurationValidator = (configuration: FleetCameraConfiguration) => unknown;

export class FleetConfigurationBusyError extends Error {
  readonly code = "FLEET_CONFIG_BUSY";
  constructor(readonly lockPath: string) {
    super(`Fleet configuration is being updated (${lockPath}); retry after the current writer finishes.`);
    this.name = "FleetConfigurationBusyError";
  }
}

export function assertUniqueFleetHardwareBindings(bindings: {
  id: string; serial?: string; serialPrefix?: string; cameraIdentity?: string;
  driverPort?: number; cameraStreamPort?: number; digitalStreamPort?: number;
}[]) {
  const ports = new Set<number>();
  for (let index = 0; index < bindings.length; index++) {
    const binding = bindings[index];
    for (const port of [binding.driverPort, binding.cameraStreamPort, binding.digitalStreamPort]) {
      if (!port) continue;
      if (ports.has(port)) throw new Error(`Duplicate fleet listener port: ${port}`);
      ports.add(port);
    }
    for (const previous of bindings.slice(0, index)) {
      const leftCamera = binding.cameraIdentity?.toLowerCase();
      const rightCamera = previous.cameraIdentity?.toLowerCase();
      if (leftCamera && rightCamera && (leftCamera.startsWith(rightCamera) || rightCamera.startsWith(leftCamera))) {
        throw new Error(`Camera identities overlap for ${previous.id} and ${binding.id}`);
      }
      const leftSerial = binding.serial || binding.serialPrefix;
      const rightSerial = previous.serial || previous.serialPrefix;
      if (leftSerial && rightSerial && (leftSerial === rightSerial ||
        Boolean(binding.serialPrefix && rightSerial.startsWith(binding.serialPrefix)) ||
        Boolean(previous.serialPrefix && leftSerial.startsWith(previous.serialPrefix)))) {
        throw new Error(`Controller identities overlap for ${previous.id} and ${binding.id}`);
      }
    }
  }
}

function validateDocument(value: unknown): asserts value is FleetCameraConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid fleet configuration document");
  const configuration = value as FleetCameraConfiguration;
  cameraPolicy(configuration);
  hardwareDiscoveryPolicy(configuration);
  const ids = new Set<string>();
  for (const device of configuration.devices) {
    if (!device || typeof device !== "object" || typeof device.id !== "string" || !/^[a-zA-Z0-9._-]{1,120}$/.test(device.id)) throw new Error("Invalid fleet device identity");
    if (ids.has(device.id)) throw new Error(`Duplicate fleet device identity: ${device.id}`);
    ids.add(device.id);
  }
}

/** Every writer must acquire this same lock before reading the file it will change. */
function acquireConfigurationLock(path: string) {
  const lockPath = `${path}.write-lock`;
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(lockPath, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FleetConfigurationBusyError(lockPath);
    throw error;
  }
  const ownerPath = `${lockPath}/owner.json`;
  const token = randomUUID();
  try { writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    try { unlinkSync(ownerPath); } catch { /* A failed write may not have created the file. */ }
    rmdirSync(lockPath);
    throw error;
  }
  return () => {
    // A writer never steals or deletes an unknown lock. A crash leaves an
    // inspectable lock rather than allowing overlapping configuration writes.
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { token?: string };
    if (owner.token !== token) throw new Error("Fleet configuration lock ownership changed");
    unlinkSync(ownerPath);
    rmdirSync(lockPath);
  };
}

/** A short synchronous transaction; transforms must not await or write hardware. */
export function updateFleetConfigurationSync(
  configPath: string,
  transform: ConfigurationTransform,
  validate?: ConfigurationValidator,
): FleetCameraConfiguration {
  const path = resolve(configPath);
  const release = acquireConfigurationLock(path);
  let temporary: string | undefined;
  try {
    let current: unknown;
    try { current = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = { devices: [] };
    }
    validateDocument(current);
    validate?.(current);
    const next = transform(current);
    validateDocument(next);
    validate?.(next);
    if (next === current) return current;
    temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, "utf8"); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temporary, path);
    temporary = undefined;
    return next;
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* The transaction already failed. */ } }
    release();
  }
}

/** Async callers wait without blocking their event loop when another process writes. */
export async function updateFleetConfiguration(
  configPath: string,
  transform: ConfigurationTransform,
  options: { validate?: ConfigurationValidator; timeoutMs?: number } = {},
) {
  const timeout = options.timeoutMs ?? 1_500;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 10_000) throw new Error("Invalid fleet configuration lock timeout");
  const deadline = Date.now() + timeout;
  for (;;) {
    try { return updateFleetConfigurationSync(configPath, transform, options.validate); }
    catch (error) {
      if (!(error instanceof FleetConfigurationBusyError) || Date.now() >= deadline) throw error;
      await delay(Math.min(20, Math.max(1, deadline - Date.now())));
    }
  }
}

/** Append only to the latest document; a stale discovery may never replace a binding. */
export function appendDiscoveredFleetDevices<T extends { id: string }>(
  current: FleetCameraConfiguration,
  expectedBindings: T[],
  validatedCurrentBindings: T[],
  additions: T[],
): FleetCameraConfiguration {
  if (!hardwareDiscoveryPolicy(current).automaticEnrollment) {
    throw new Error("Automatic hardware enrollment was paused; retry discovery without changing existing bindings.");
  }
  const currentById = new Map(validatedCurrentBindings.map(device => [device.id, device]));
  for (const expected of expectedBindings) {
    const actual = currentById.get(expected.id);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Fleet binding ${expected.id} changed during discovery; retry with current physical identities.`);
    }
  }
  for (const addition of additions) {
    if (currentById.has(addition.id)) throw new Error(`Fleet device ${addition.id} was enrolled by another writer; retry discovery.`);
    currentById.set(addition.id, addition);
  }
  return { ...current, devices: [...current.devices, ...additions] };
}
