type FleetEntry = Record<string, unknown>;

export type WiredMirrorBinding = {
  identity: string;
  port: number;
  height: 1280 | 1560;
};

// Allow a single node to pick up a newly commissioned mirror without
// restarting the fleet's motor drivers. Never infer a phone from its name,
// list order, or the fact that it is the only connected iPhone.
export function resolveWiredMirrorBinding(
  config: unknown,
  current: { deviceId: string; driverUrl: string; cameraIdentity: string; streamPort?: number; frameHeight?: number },
): WiredMirrorBinding | null {
  const devices = (config as { devices?: unknown[] } | null)?.devices;
  if (!Array.isArray(devices)) throw new Error("Invalid fleet device configuration");
  const entries = devices.filter(
    (entry): entry is FleetEntry => Boolean(entry) && typeof entry === "object",
  );
  const matches = entries.filter(entry => entry.id === current.deviceId);
  if (matches.length > 1) throw new Error("Duplicate fleet device identity");
  const entry = matches[0];
  if (!entry || !entry.digitalIdentity) return null;
  const identity = String(entry.digitalIdentity).trim();
  if (!identity) throw new Error("Empty iPhone identity");
  const driver = new URL(current.driverUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(driver.hostname) ||
    Number(driver.port) !== Number(entry.driverPort) ||
    !current.cameraIdentity ||
    String(entry.cameraIdentity).toLowerCase() !== current.cameraIdentity.toLowerCase()
  ) throw new Error("Mirror binding does not match this controller and camera");
  if (entries.filter(candidate => String(candidate.digitalIdentity ?? "").trim() === identity).length !== 1) {
    throw new Error("An iPhone mirror cannot be assigned to multiple devices");
  }
  const port = Number(entry.digitalStreamPort);
  if (!Number.isInteger(port) || port < 3000 || port > 65535) {
    throw new Error("Invalid iPhone mirror port");
  }
  if (entries.some(candidate =>
    Number(candidate.driverPort) === port ||
    Number(candidate.cameraStreamPort) === port ||
    (candidate !== entry && Number(candidate.digitalStreamPort) === port)
  )) throw new Error("iPhone mirror port conflicts with another device service");
  const height = Number(entry.digitalFrameHeight ?? 1560);
  if (height !== 1280 && height !== 1560) throw new Error("Unsupported iPhone mirror height");
  if (current.streamPort !== undefined && current.streamPort !== port) {
    throw new Error("Configured mirror port disagrees with the node stream port");
  }
  if (current.frameHeight !== undefined && current.frameHeight !== height) {
    throw new Error("Configured mirror geometry disagrees with the node frame height");
  }
  return { identity, port, height };
}
