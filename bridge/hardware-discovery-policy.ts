export type HardwareDiscoveryPolicy = { automaticEnrollment: boolean };

/** Missing policy retains the existing behavior; an invalid policy never enables enrollment. */
export function hardwareDiscoveryPolicy(configuration: unknown): HardwareDiscoveryPolicy {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) throw new Error("Invalid hardware discovery configuration");
  const value = (configuration as Record<string, unknown>).hardwareDiscovery;
  if (value === undefined) return { automaticEnrollment: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hardware discovery policy");
  const automaticEnrollment = (value as Record<string, unknown>).automaticEnrollment;
  if (automaticEnrollment !== undefined && typeof automaticEnrollment !== "boolean") throw new Error("Invalid automatic hardware enrollment setting");
  return { automaticEnrollment: automaticEnrollment ?? true };
}

/** Paused discovery never invokes code that allocates IDs, persists, or starts new hardware. */
export function withAutomaticHardwareEnrollment<T>(
  policy: HardwareDiscoveryPolicy,
  bindings: T[],
  enroll: () => T[],
): { bindings: T[]; paused: boolean } {
  if (!policy.automaticEnrollment) return { bindings, paused: true };
  return { bindings: enroll(), paused: false };
}
