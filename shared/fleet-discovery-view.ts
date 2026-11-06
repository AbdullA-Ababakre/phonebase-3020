export type FleetDiscoveryView = {
  available: boolean;
  stale: boolean;
  observedAt: number | null;
  detail: string | null;
  discoveryPending: boolean;
  automaticEnrollment: boolean;
  configured: Array<{
    id: string;
    controllerPresent: boolean;
    cameraResolved: boolean;
    reason: string | null;
    nodeConnected: boolean;
    liveVideo: boolean;
  }>;
  unclaimed: { controllers: string[]; cameras: Array<{ identity: string; name: string }> };
};
