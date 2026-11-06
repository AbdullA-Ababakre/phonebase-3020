/** Bounded frames in flight; acknowledgements release only frames actually sent. */
export class RemoteFrameWindow {
  private started = false;
  private sequences: number[] = [];
  readonly size: number;

  constructor(requested: string | null) {
    const value = Number(requested);
    this.size = Number.isInteger(value) && value >= 1 ? Math.min(value, 3) : 1;
  }

  get available() {
    return this.started && this.sequences.length < this.size;
  }

  start() {
    this.started = true;
  }

  sent(sequence: number) {
    this.sequences.push(sequence);
  }

  acknowledge(sequence: number) {
    const index = this.sequences.indexOf(sequence);
    if (index < 0) return;
    // The browser may skip an older frame while decoding a newer one.
    this.sequences.splice(0, index + 1);
  }
}
