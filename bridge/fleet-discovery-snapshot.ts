import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type FleetDiscoveryObservation = {
  observedAt: number;
  serials: string[];
  cameras: { index: string; name: string; uniqueId: string }[];
};
export type FleetDiscoverySnapshot = {
  version: 1;
  observedAt: number;
  publishedAt: number;
  discoveryPending: boolean;
  automaticEnrollment: boolean;
  configured: { id: string; controllerPresent: boolean; cameraResolved: boolean; reason: string | null }[];
  unclaimed: { controllers: string[]; cameras: { identity: string; name: string }[] };
};

export function fleetDiscoverySnapshot(
  bindings: { id: string; serial?: string; serialPrefix?: string; cameraIdentity?: string; camera?: string }[],
  observation: FleetDiscoveryObservation,
  assignments: ReadonlyMap<string, string>,
  discoveryPending: boolean,
  publishedAt = Date.now(),
  automaticEnrollment = true,
): FleetDiscoverySnapshot {
  const claimsSerial = (binding: typeof bindings[number], serial: string) => binding.serial === serial || Boolean(binding.serialPrefix && serial.startsWith(binding.serialPrefix));
  const claimsCamera = (binding: typeof bindings[number], identity: string) => Boolean(binding.cameraIdentity && identity.toLowerCase().startsWith(binding.cameraIdentity.toLowerCase()));
  return {
    version: 1,
    observedAt: observation.observedAt,
    publishedAt,
    discoveryPending,
    automaticEnrollment,
    configured: bindings.map(binding => {
      const controllerPresent = observation.serials.some(serial => claimsSerial(binding, serial));
      const cameraResolved = assignments.has(binding.id);
      const reason = !controllerPresent && !cameraResolved ? "Controller and configured camera are not resolved."
        : !controllerPresent ? "The configured USB controller is not present."
          : !cameraResolved ? "The configured camera identity has not resolved in AVFoundation." : null;
      return { id: binding.id, controllerPresent, cameraResolved, reason };
    }),
    unclaimed: {
      controllers: observation.serials.filter(serial => !bindings.some(binding => claimsSerial(binding, serial))).sort(),
      cameras: observation.cameras.filter(camera => /^USB Camera2$/i.test(camera.name) && !bindings.some(binding => claimsCamera(binding, camera.uniqueId)))
        .map(camera => ({ identity: camera.uniqueId, name: camera.name })).sort((a, b) => a.identity.localeCompare(b.identity)),
    },
  };
}

export function writeFleetDiscoverySnapshot(path: string, snapshot: FleetDiscoverySnapshot) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch { /* Renamed or already removed. */ } }
}
