export type CameraCandidate = { id: string; capturePriority?: number };
export type CameraPolicy = { maximumActiveCameras?: number; focusDeviceId?: string; focusedAt?: number };
export type FleetCameraConfiguration = { devices: CameraCandidate[]; videoCapture?: CameraPolicy; [key: string]: unknown };

export function cameraPolicy(configuration: FleetCameraConfiguration): CameraPolicy {
  if (!Array.isArray(configuration.devices)) throw new Error("Invalid camera devices");
  const policy = configuration.videoCapture ?? {};
  if (policy.maximumActiveCameras !== undefined &&
    (!Number.isInteger(policy.maximumActiveCameras) || policy.maximumActiveCameras < 1 || policy.maximumActiveCameras > 32)) {
    throw new Error('Invalid maximum active camera count');
  }
  if (policy.focusDeviceId !== undefined &&
    !configuration.devices.some(device => device.id === policy.focusDeviceId)) throw new Error('Unknown focused camera');
  if (policy.focusedAt !== undefined && (!Number.isFinite(policy.focusedAt) || policy.focusedAt < 0)) throw new Error("Invalid camera focus time");
  return policy;
}

/** A selected camera receives a real capture slot; protected cameras keep theirs. */
export function selectCameraCaptures<T extends CameraCandidate>(candidates: T[], policy: CameraPolicy): T[] {
  if (new Set(candidates.map(device => device.id)).size !== candidates.length) throw new Error('Duplicate camera identity');
  const ordered = [...candidates].sort((a, b) => (b.capturePriority ?? 0) - (a.capturePriority ?? 0));
  const maximum = policy.maximumActiveCameras ?? ordered.length;
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 32) throw new Error('Invalid camera capture limit');
  const selected = ordered.filter(device => (device.capturePriority ?? 0) >= 100);
  if (selected.length > maximum) throw new Error('Camera limit cannot exclude protected cameras');
  const focused = ordered.find(device => device.id === policy.focusDeviceId);
  if (focused && !selected.includes(focused)) {
    if (selected.length >= maximum) throw new Error('All camera slots are protected');
    selected.push(focused);
  }
  for (const device of ordered) if (!selected.includes(device) && selected.length < maximum) selected.push(device);
  return selected;
}

export function configurationWithCameraFocus(
  configuration: FleetCameraConfiguration, deviceId: string, connectedIds: string[], busyIds: string[],
): FleetCameraConfiguration {
  if (!connectedIds.includes(deviceId) || !configuration.devices.some(device => device.id === deviceId)) {
    throw new Error('Select a connected camera device');
  }
  const policy = cameraPolicy(configuration);
  if (policy.focusDeviceId === deviceId || (configuration.devices.find(device => device.id === deviceId)?.capturePriority ?? 0) >= 100) return configuration;
  const candidates = configuration.devices.filter(device => connectedIds.includes(device.id));
  const before = selectCameraCaptures(candidates, policy);
  const nextPolicy = { ...policy, focusDeviceId: deviceId, focusedAt: Date.now() };
  const after = selectCameraCaptures(candidates, nextPolicy);
  const afterIds = new Set(after.map(device => device.id));
  if (before.some(device => !afterIds.has(device.id) && busyIds.includes(device.id))) {
    throw new Error('The current device is executing. Wait for it to finish before switching video.');
  }
  return { ...configuration, videoCapture: nextPolicy };
}
