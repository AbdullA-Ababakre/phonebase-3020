export type CameraProcessSpec = { id: string; signature: string; command: string; args: string[] };
export type CameraProcess = {
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(signal: "SIGTERM"): unknown;
};

/** A capture failure, config change, or unplug affects only that camera. */
export class CameraProcessPool {
  private entries = new Map<string, { spec: CameraProcessSpec; process: CameraProcess }>();
  private retries = new Map<string, { failures: number; at: number; startedAt: number }>();
  private nextLaunchAt = 0;
  constructor(
    private launch: (spec: CameraProcessSpec) => CameraProcess,
    private now = Date.now,
    private launchSpacingMs = 0,
  ) {}

  reconcile(specs: CameraProcessSpec[]) {
    const desired = new Map(specs.map(spec => [spec.id, spec]));
    if (desired.size !== specs.length) throw new Error("Duplicate camera process identity");
    for (const [id, entry] of this.entries) {
      if (desired.get(id)?.signature === entry.spec.signature) continue;
      this.entries.delete(id);
      this.retries.delete(id);
      entry.process.kill("SIGTERM");
    }
    for (const id of this.retries.keys()) if (!desired.has(id)) this.retries.delete(id);
    for (const spec of specs) {
      if (this.entries.has(spec.id) || (this.retries.get(spec.id)?.at ?? 0) > this.now() || this.nextLaunchAt > this.now()) continue;
      let process: CameraProcess;
      try { process = this.launch(spec); }
      catch { this.failed(spec.id); continue; }
      this.nextLaunchAt = this.now() + this.launchSpacingMs;
      this.entries.set(spec.id, { spec, process });
      const previous = this.retries.get(spec.id);
      this.retries.set(spec.id, { failures: previous?.failures ?? 0, at: 0, startedAt: this.now() });
      const failed = () => {
        if (this.entries.get(spec.id)?.process !== process) return;
        this.entries.delete(spec.id);
        this.failed(spec.id);
      };
      process.once("error", failed);
      process.once("exit", failed);
    }
  }

  private failed(id: string) {
    const previous = this.retries.get(id);
    const stable = previous && this.now() - previous.startedAt >= 30_000;
    const failures = stable ? 1 : (previous?.failures ?? 0) + 1;
    this.retries.set(id, {
      failures, startedAt: this.now(),
      at: this.now() + Math.min(8_000, 1_000 * 2 ** Math.min(failures - 1, 3)),
    });
  }

  stop() {
    const entries = [...this.entries.values()];
    this.entries.clear(); this.retries.clear(); this.nextLaunchAt = 0;
    for (const entry of entries) entry.process.kill("SIGTERM");
  }
}
