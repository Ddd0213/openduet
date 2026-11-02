/**
 * A turn-owned inbox. Reserve synchronously before persistence, then settle the reservation
 * after the input is durable. An empty final poll closes admission without an await gap.
 * Closing waits for accepted writes, so the turn's done cannot overtake their message echoes.
 */
export class SteeringInbox<T> {
  private accepting = false;
  private closed = false;
  private pending: Promise<{ value: T } | undefined>[] = [];

  open(): void { if (!this.closed) this.accepting = true; }

  reserve(): ((value?: T) => void) | null {
    if (!this.accepting || this.closed) return null;
    let finish!: (value?: T) => void;
    this.pending.push(new Promise<{ value: T } | undefined>((resolve) => { finish = (value) => resolve(value === undefined ? undefined : { value }); }));
    return finish;
  }

  async take(closeIfEmpty = false): Promise<T[]> {
    const batch = this.pending.splice(0);
    if (!batch.length && closeIfEmpty) this.closed = true;
    const values = await Promise.all(batch);
    const ready = values.flatMap((entry) => entry ? [entry.value] : []);
    // Failed writes release their reservation; still close atomically after any admissions
    // that arrived while those writes were settling.
    return closeIfEmpty && batch.length && !ready.length ? this.take(true) : ready;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.take();
  }

  /** Accepted input the turn hasn't taken yet (a write may still be settling). */
  waiting(): boolean {
    return this.accepting && !this.closed && this.pending.length > 0;
  }
}
