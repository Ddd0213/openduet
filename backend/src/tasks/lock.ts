// Serializes async work per key (a task, a card, an Up next item) inside this one process, so a
// double tap or a tool call racing an approval outcome never loses a JSON column update.
export class KeyedLock {
  /** M14: the one lock for task rows, shared by TaskService and the build outcome hook (tasks/builds.ts). */
  static readonly tasks = new KeyedLock();

  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(work);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
