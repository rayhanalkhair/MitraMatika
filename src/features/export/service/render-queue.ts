let tail: Promise<unknown> = Promise.resolve();

/**
 * Runs PDF renders one at a time in this server instance: a render is synchronous work of
 * seconds and hundreds of MB, and two exports may run at once when two runner invocations share
 * an instance. A rejected work does not stop the queue.
 */
export function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.catch(() => undefined);
  return run;
}
