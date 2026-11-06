import { readFileSync, statSync } from "node:fs";
import type { FleetDiscoveryView } from "../shared/fleet-discovery-view";

type LiveDevice = { id: string; connected: boolean; liveVideo: boolean };
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_OBSERVATION_AGE_MS = 60_000;

function unavailable(detail: string): FleetDiscoveryView {
  return { available: false, stale: true, observedAt: null, detail,
    discoveryPending: false, automaticEnrollment: true, configured: [], unclaimed: { controllers: [], cameras: [] } };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid discovery report");
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum = 256) {
  if (typeof value !== "string" || value.length > maximum || /[\x00-\x1f]/.test(value)) throw new Error("Invalid discovery report field");
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid discovery report list");
  return value;
}

/** Discovery is diagnostic evidence only. Connected/live state always comes from live nodes. */
export function fleetDiscoveryView(value: unknown, liveDevices: LiveDevice[], now = Date.now()): FleetDiscoveryView {
  try {
    const report = object(value);
    if (report.version !== 1 || typeof report.observedAt !== "number" || !Number.isFinite(report.observedAt) ||
      report.observedAt < 0 || report.observedAt > now + 5_000 || typeof report.discoveryPending !== "boolean") throw new Error("Invalid discovery report header");
    if (report.automaticEnrollment !== undefined && typeof report.automaticEnrollment !== "boolean") throw new Error("Invalid discovery enrollment policy");
    const liveById = new Map(liveDevices.map(device => [device.id, device]));
    const ids = new Set<string>();
    const configured = list(report.configured).map(value => {
      const entry = object(value), id = text(entry.id, 120);
      if (!/^[a-zA-Z0-9._-]{1,120}$/.test(id) || ids.has(id) || typeof entry.controllerPresent !== "boolean" || typeof entry.cameraResolved !== "boolean") throw new Error("Invalid discovery identity");
      ids.add(id);
      const live = liveById.get(id);
      return { id, controllerPresent: entry.controllerPresent, cameraResolved: entry.cameraResolved,
        reason: entry.reason === null ? null : text(entry.reason, 512),
        nodeConnected: live?.connected === true, liveVideo: live?.connected === true && live.liveVideo };
    });
    const unclaimed = object(report.unclaimed);
    const controllers = list(unclaimed.controllers).map(value => {
      const path = text(value);
      if (!/^\/dev\/cu\.usbserial-[a-zA-Z0-9._-]+$/.test(path)) throw new Error("Invalid controller identity");
      return path;
    });
    const cameras = list(unclaimed.cameras).map(value => {
      const camera = object(value);
      return { identity: text(camera.identity), name: text(camera.name, 120) };
    });
    const stale = now - report.observedAt > MAX_OBSERVATION_AGE_MS;
    return { available: true, stale, observedAt: report.observedAt,
      detail: stale ? "Hardware discovery has not refreshed recently. Component presence below may be outdated." : null,
      discoveryPending: report.discoveryPending, automaticEnrollment: report.automaticEnrollment !== false,
      configured, unclaimed: { controllers, cameras } };
  } catch {
    return unavailable("The hardware discovery report is invalid. Live device status remains available above.");
  }
}

export function readFleetDiscoveryView(path: string, liveDevices: LiveDevice[], now = Date.now()): FleetDiscoveryView {
  try {
    if (statSync(path).size > MAX_REPORT_BYTES) throw new Error("Oversized report");
    return fleetDiscoveryView(JSON.parse(readFileSync(path, "utf8")), liveDevices, now);
  } catch (error) {
    return unavailable((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "Waiting for the fleet manager's hardware discovery report."
      : "The hardware discovery report cannot be read. Live device status remains available above.");
  }
}
