type DeviceState = {
  connected: boolean;
  state?: { videoCapture?: { scheduled?: boolean } | null; cameraReady?: boolean; grbl?: { homed?: boolean; state?: string; activeOperation?: { status?: string } | null } } | null;
  capabilities: { actions: { tap: { available: boolean; reason?: string } } };
};

/** Display the recovery step while preserving the API's actual action gate. */
export function deviceAvailability(device: DeviceState, remote = false) {
  if (!device.connected) return { label: "Reconnecting", detail: "Reconnecting to the device. Control resumes when the connection is restored." };
  const hardware = device.state?.grbl;
  if (/alarm|fault|error/i.test(hardware?.state ?? "")) {
    return { label: "Needs attention", detail: remote ? "Your operator is checking the device. Please wait." : "The controller reported a hardware alarm. Check its status before continuing." };
  }
  if (/hold/i.test(hardware?.state ?? "")) return { label: "Paused", detail: "The controller is paused. Resume it when the workspace is clear." };
  if (hardware?.activeOperation?.status === "running") return { label: "Executing", detail: "The current action is running." };
  if (device.state?.videoCapture?.scheduled === false) return { label: "Video standby", detail: remote ? "Your operator manages this phone's live video." : "Open this device or select Start live video to activate its camera." };
  if (device.capabilities.actions.tap.available) return { label: "Available", detail: "Ready for phone control." };
  const reason = device.capabilities.actions.tap.reason ?? "";
  if (/fresh|frame|video|camera|synchron|wired screen/i.test(reason)) {
    return { label: "Reconnecting video", detail: "Restoring live video. Control resumes after a fresh, verified image arrives." };
  }
  if (!hardware?.homed || /calibrat|screen map|reference|setup/i.test(reason)) {
    return { label: remote ? "Preparing device" : "Setup required", detail: remote ? "Your operator is preparing this phone. No setup is needed from you." : reason.replace(/locked/gi, "not ready") || "Complete this device's setup before using phone control." };
  }
  return { label: "Temporarily unavailable", detail: remote ? "Your operator is checking the device. Please wait." : reason.replace(/locked/gi, "not ready") || "Check this device's current status." };
}
