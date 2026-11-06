export class PhysicalCommandLock {
  private activeCommandId: string | null = null;

  get busy() {
    return this.activeCommandId !== null;
  }

  acquire(commandId: string) {
    if (!commandId || this.activeCommandId) return false;
    this.activeCommandId = commandId;
    return true;
  }

  release(commandId: string) {
    if (this.activeCommandId !== commandId) return false;
    this.activeCommandId = null;
    return true;
  }
}
