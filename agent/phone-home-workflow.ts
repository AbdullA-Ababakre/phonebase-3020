/** One observed Home attempt. Recognized switcher/library scenes get one
 * scene-specific recovery; other screens use the calibrated bottom-edge tap.
 * Never repeat a swipe or tap an app-card/dock position as a blind fallback. */
export async function waitForPhoneHomeReadiness(io: {
  checkpoint(): Promise<void>;
  readiness(): { ready: boolean; waitingForScreenSync: boolean; reason?: string };
  now(): number;
  sleep(ms: number): Promise<void>;
}, timeoutMs = 5_000) {
  const deadline = io.now() + timeoutMs;
  while (true) {
    await io.checkpoint();
    const state = io.readiness();
    if (state.ready) return;
    if (!state.waitingForScreenSync) throw new Error(state.reason || "Phone Home is not ready.");
    if (io.now() >= deadline) throw new Error("Camera and HD mirror did not synchronize before Phone Home continued. No further motion was sent.");
    // Observe only: never replay a gesture while synchronization is pending.
    await io.sleep(Math.min(100, deadline - io.now()));
  }
}

export async function runPhoneHomeWorkflow<T extends { homeVisible: boolean; appLibraryVisible?: boolean; appSwitcherVisible?: boolean }>(io: {
  checkpoint(): Promise<void>;
  observe(afterCompletedAt?: number): Promise<T>;
  swipe(observation: T): Promise<number>;
  dismissAtVerifiedBottomEdge?(observation: T): Promise<number>;
  exitAppLibrary?(observation: T): Promise<number>;
  exitAppSwitcher?(observation: T): Promise<number>;
}) {
  const leaveSwitcher = async (observation: T) => {
    await io.checkpoint();
    const completedAt = await io.exitAppSwitcher!(observation);
    await io.checkpoint();
    const after = await io.observe(completedAt);
    return { phoneUiVerified: after.homeVisible, alreadyHome: false, recoveryUsed: true, recoveryKind: "app-switcher" as const };
  };
  const leaveLibrary = async (observation: T) => {
    await io.checkpoint();
    const completedAt = await io.exitAppLibrary!(observation);
    await io.checkpoint();
    const after = await io.observe(completedAt);
    return { phoneUiVerified: after.homeVisible, alreadyHome: false, recoveryUsed: true, recoveryKind: "app-library" as const };
  };
  await io.checkpoint();
  let observation = await io.observe();
  if (observation.homeVisible) return { phoneUiVerified: true, alreadyHome: true, recoveryUsed: false };
  if (observation.appSwitcherVisible && io.exitAppSwitcher) return leaveSwitcher(observation);
  if (observation.appLibraryVisible && io.exitAppLibrary) return leaveLibrary(observation);
  await io.checkpoint();
  const swipeCompletedAt = await io.swipe(observation);
  await io.checkpoint();
  observation = await io.observe(swipeCompletedAt);
  if (observation.homeVisible) return { phoneUiVerified: true, alreadyHome: false, recoveryUsed: false };
  if (observation.appSwitcherVisible && io.exitAppSwitcher) return leaveSwitcher(observation);
  if (observation.appLibraryVisible && io.exitAppLibrary) return leaveLibrary(observation);
  if (!io.dismissAtVerifiedBottomEdge) {
    return { phoneUiVerified: false, alreadyHome: false, recoveryUsed: false };
  }
  // The recovery point is separately commissioned in the system-gesture gutter,
  // NOT the old 90%-height point that can launch a dock app after Home succeeds.
  await io.checkpoint();
  const tapCompletedAt = await io.dismissAtVerifiedBottomEdge(observation);
  await io.checkpoint();
  observation = await io.observe(tapCompletedAt);
  return { phoneUiVerified: observation.homeVisible, alreadyHome: false, recoveryUsed: true };
}
