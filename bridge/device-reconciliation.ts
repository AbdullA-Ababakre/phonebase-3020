export type ControllerCameraBinding = {
  serial: string;
  driverPort: number;
  camera?: string;
  cameraIdentity?: string;
};

/** Changing a camera binding must not discard this controller's homing reference. */
export function deviceReconciliation(
  previous: ControllerCameraBinding,
  current: ControllerCameraBinding | undefined,
  previousSerialPresent: boolean,
): 'retain' | 'replace-node' | 'stop' {
  if (!previousSerialPresent) return 'stop';
  if (!current) return 'retain'; // Camera temporarily absent, controller still present.
  if (current.serial !== previous.serial || current.driverPort !== previous.driverPort) return 'stop';
  const sameCamera = current.cameraIdentity
    ? current.cameraIdentity === previous.cameraIdentity
    : current.camera === previous.camera;
  return sameCamera ? 'retain' : 'replace-node';
}
