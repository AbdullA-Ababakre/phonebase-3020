import { parsePhonebaseCalibrationProfile } from "../agent/calibration-profile";

export type CommissionedTapProfile = {
  id: string;
  deviceId: string;
  verifiedAt: number;
  hoverZ: number;
  touchZ: number;
  normalTouchZ?: number;
};

export type CommissionedProfilePolicy = {
  deviceId: string;
  configuredProfileId?: string;
  hoverZ: number;
  minimumTouchZ: number;
  maximumTouchZ: number;
};

/** Pure validation; a profile must fit this node's existing physical limits. */
export function validateCommissionedTapProfile(
  input: unknown,
  policy: CommissionedProfilePolicy,
): CommissionedTapProfile | null {
  try {
    const profile = parsePhonebaseCalibrationProfile(input);
    const configuredId = policy.configuredProfileId?.trim();
    const explicitId = configuredId && !/^(unconfigured|placeholder|default)$/i.test(configuredId)
      ? configuredId : undefined;
    const verifiedAt = Date.parse(profile.verifiedAt);
    if (profile.deviceId !== policy.deviceId ||
        (profile.id !== `phonebase-${policy.deviceId}-physical-v1` && profile.id !== explicitId) ||
        !Number.isFinite(verifiedAt) ||
        !Number.isFinite(policy.hoverZ) ||
        !Number.isFinite(policy.minimumTouchZ) || !Number.isFinite(policy.maximumTouchZ) ||
        policy.minimumTouchZ > policy.maximumTouchZ ||
        profile.tap.hoverZ !== policy.hoverZ) return null;
    for (const touchZ of [profile.tap.touchZ, profile.tap.normalTouchZ]) {
      if (touchZ !== undefined && (touchZ < policy.minimumTouchZ || touchZ > policy.maximumTouchZ)) {
        return null;
      }
    }
    return {
      id: profile.id,
      deviceId: profile.deviceId,
      verifiedAt,
      hoverZ: profile.tap.hoverZ,
      touchZ: profile.tap.touchZ,
      ...(profile.tap.normalTouchZ === undefined ? {} : { normalTouchZ: profile.tap.normalTouchZ }),
    };
  } catch {
    return null;
  }
}

/** Missing/invalid/older files revoke readiness immediately. New parameters
 * are adopted only at an idle boundary; an in-flight operation keeps its data. */
export function refreshCommissionedTapProfile(input: {
  current: CommissionedTapProfile | null;
  currentReady: boolean;
  candidate: CommissionedTapProfile | null;
  latestVerifiedAt: number;
  canAdopt: boolean;
}) {
  const { current, currentReady, candidate, latestVerifiedAt, canAdopt } = input;
  const unchanged = current !== null && candidate !== null &&
    current.id === candidate.id && current.deviceId === candidate.deviceId &&
    current.verifiedAt === candidate.verifiedAt && current.hoverZ === candidate.hoverZ &&
    current.touchZ === candidate.touchZ && current.normalTouchZ === candidate.normalTouchZ;
  if (!candidate || candidate.verifiedAt < latestVerifiedAt || (!canAdopt && !(currentReady && unchanged))) {
    return { profile: current, ready: false, latestVerifiedAt };
  }
  return { profile: candidate, ready: true, latestVerifiedAt: Math.max(latestVerifiedAt, candidate.verifiedAt) };
}
