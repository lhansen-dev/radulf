/**
 * A promise-chain mutex. Each call captures the current tail, replaces it
 * with its own "done" promise, then awaits the tail it captured, so
 * operations run one at a time in arrival order, and one that throws still
 * releases the next.
 */
export function createSerialQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async (operation) => {
    const previous = tail;
    const { promise: done, resolve: release } = Promise.withResolvers<void>();
    tail = done;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}
