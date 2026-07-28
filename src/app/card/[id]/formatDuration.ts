/**
 * Return a human-readable duration string.
 *
 * When `endedAt` is non-null the elapsed time is computed from the two
 * timestamps.  When `endedAt` is `null` **and** `nowMs` is provided the
 * elapsed time is computed from `nowMs` instead of returning the fallback
 * `"—"` (which is the behaviour when `nowMs` is omitted).
 */
export function formatDuration(
  startedAt: string,
  endedAt: string | null,
  nowMs?: number,
): string {
  const end = endedAt ? new Date(endedAt).getTime() : nowMs;
  if (end === undefined) return "—";
  const ms = end - new Date(startedAt).getTime();
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}
