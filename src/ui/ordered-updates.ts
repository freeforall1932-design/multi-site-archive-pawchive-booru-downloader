/** Serialize UI mutations and let callers ignore responses superseded by newer edits. */
export class OrderedUpdates {
  private tail: Promise<void> = Promise.resolve();
  private revision = 0;

  run<T>(operation: () => Promise<T>, apply: (value: T, isLatest: () => boolean) => void | Promise<void>): Promise<void> {
    const revision = ++this.revision;
    const job = this.tail.then(async () => {
      const value = await operation();
      await apply(value, () => revision === this.revision);
    });
    // A failed operation must not block subsequent edits.
    this.tail = job.catch(() => undefined);
    return job;
  }
}
