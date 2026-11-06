/** USB enumeration and AVFoundation registration do not become ready atomically. */
export class PendingHardwareDiscoveryRefresh {
  private signature: string | null = null;
  private pending = false;
  private nextRetryAt = 0;
  private nextPeriodicAt = 0;

  shouldRefresh(signature: string, now: number) {
    return signature !== this.signature || (this.pending && now >= this.nextRetryAt) || now >= this.nextPeriodicAt;
  }

  settled(signature: string, pending: boolean, now: number) {
    this.signature = signature;
    this.pending = pending;
    this.nextRetryAt = now + 5_000;
    this.nextPeriodicAt = now + 30_000;
  }
}
