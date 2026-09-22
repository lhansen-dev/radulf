/**
 * Resolve after `ms`. The timer is unref'd so a pending sleep never holds
 * the process open on its own; whatever the caller is waiting for does that.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
