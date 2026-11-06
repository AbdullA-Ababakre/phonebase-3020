export type UsbControllerCandidate = {
  serial: string;
  location: string;
};

export type UsbCameraCandidate = {
  identity: string;
  location: string;
};

export type UsbHardwarePair = {
  controller: UsbControllerCandidate;
  camera: UsbCameraCandidate;
  affinity: number;
};

export function normalizeUsbLocation(value: string) {
  const hex = value.toLowerCase().replace(/^0x/, "").replace(/[^0-9a-f]/g, "");
  return hex.padStart(8, "0").slice(-8);
}

export function usbTopologyAffinity(left: string, right: string) {
  const a = normalizeUsbLocation(left);
  const b = normalizeUsbLocation(right);
  let common = 0;
  while (common < a.length && a[common] === b[common]) common += 1;
  return common;
}

/**
 * Pair every controller with one camera by maximizing the total shared USB
 * topology prefix. A global assignment is important: a greedy match can take
 * the only good camera for a neighboring controller on a large hub.
 *
 * The result is deterministic for equal scores. Callers must still commission
 * new pairs as unconfigured; topology is a station-slot identity, not proof of
 * calibration or permission to move hardware.
 */
export function pairUsbHardware(
  controllers: UsbControllerCandidate[],
  cameras: UsbCameraCandidate[],
): UsbHardwarePair[] {
  if (!controllers.length || controllers.length !== cameras.length) return [];
  if (controllers.length > 16) return [];

  const sortedControllers = [...controllers].sort((a, b) =>
    normalizeUsbLocation(a.location).localeCompare(normalizeUsbLocation(b.location)) ||
    a.serial.localeCompare(b.serial)
  );
  const sortedCameras = [...cameras].sort((a, b) =>
    normalizeUsbLocation(a.location).localeCompare(normalizeUsbLocation(b.location)) ||
    a.identity.localeCompare(b.identity)
  );
  const count = sortedControllers.length;
  const memo = new Map<string, { score: number; choices: number[] }>();

  function best(controllerIndex: number, cameraMask: number): { score: number; choices: number[] } {
    if (controllerIndex === count) return { score: 0, choices: [] };
    const key = `${controllerIndex}:${cameraMask}`;
    const cached = memo.get(key);
    if (cached) return cached;
    let winner: { score: number; choices: number[] } | null = null;
    for (let cameraIndex = 0; cameraIndex < count; cameraIndex += 1) {
      if (cameraMask & (1 << cameraIndex)) continue;
      const remainder = best(controllerIndex + 1, cameraMask | (1 << cameraIndex));
      const score = usbTopologyAffinity(
        sortedControllers[controllerIndex].location,
        sortedCameras[cameraIndex].location,
      ) + remainder.score;
      const candidate = { score, choices: [cameraIndex, ...remainder.choices] };
      if (
        !winner ||
        candidate.score > winner.score ||
        (candidate.score === winner.score && candidate.choices.join(",") < winner.choices.join(","))
      ) winner = candidate;
    }
    const result = winner ?? { score: 0, choices: [] };
    memo.set(key, result);
    return result;
  }

  const assignment = best(0, 0).choices;
  return sortedControllers.map((controller, index) => {
    const camera = sortedCameras[assignment[index]];
    return {
      controller,
      camera,
      affinity: usbTopologyAffinity(controller.location, camera.location),
    };
  });
}

export function nextFleetDeviceId(existingIds: Iterable<string>, preferredPrefix = "black-arm") {
  const ids = new Set(existingIds);
  let ordinal = 1;
  while (ids.has(`${preferredPrefix}-${String(ordinal).padStart(2, "0")}`)) ordinal += 1;
  return `${preferredPrefix}-${String(ordinal).padStart(2, "0")}`;
}
