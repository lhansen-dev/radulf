"use client";
import { formatDurationMs } from "./formatDuration";
import { useNow } from "./useNow";
import { useRunActivity } from "./useRunActivity";

/** Past this long without a push, the line stops reading as reassurance. */
const QUIET_AFTER_MS = 90_000;

function elapsedSince(startedAt: string | null | undefined, now: number): string | null {
  const startMs = startedAt ? new Date(startedAt).getTime() : NaN;
  return Number.isFinite(startMs) ? formatDurationMs(Math.max(0, now - startMs)) : null;
}

/**
 * A one-line answer to "is it still going" for a live harness run: what the
 * model was last seen doing and how long ago, from the transcript pushes on
 * the shared event stream, next to how long the run has been going. Before
 * the first push it shows `idleLabel` and the elapsed time, so a wait reads
 * as a wait rather than as a page that stopped updating. A long silence
 * changes the tone rather than claiming a failure: the stall watchdog is what
 * decides that, and it ends the run with a reason of its own.
 */
export function LiveActivity({
  runId,
  startedAt,
  idleLabel,
  className = "",
}: {
  runId: string | null;
  /** ISO time the run began. Omitted or unparseable, the elapsed part is left out. */
  startedAt?: string | null;
  /** What to say before the first push, e.g. "Reading the repository". */
  idleLabel: string;
  className?: string;
}) {
  const now = useNow(true);
  const { lastAt, label } = useRunActivity(runId);
  const sinceLast = lastAt === null ? null : now - lastAt;
  const quiet = sinceLast !== null && sinceLast > QUIET_AFTER_MS;
  const elapsed = elapsedSince(startedAt, now);
  return (
    <p
      role="status"
      className={`flex flex-wrap items-center gap-x-2 text-xs ${quiet ? "text-amber-300/80" : "text-foreground/60"} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block size-2 shrink-0 rounded-full ${quiet ? "bg-amber-400" : "animate-pulse bg-emerald-400"}`}
      />
      <span className="truncate font-mono">{label ?? idleLabel}</span>
      {sinceLast !== null && <span className="text-foreground/45">{formatDurationMs(sinceLast)} ago</span>}
      {elapsed && <span className="text-foreground/45">· {elapsed} in</span>}
    </p>
  );
}

/**
 * The dot alone, for a list row: pulsing while pushes keep arriving for the
 * run, amber once they have stopped for a while, absent before the first.
 */
export function ActivityDot({ runId }: { runId: string | null }) {
  const now = useNow(true, 5_000);
  const { lastAt } = useRunActivity(runId);
  if (lastAt === null) return null;
  const quiet = now - lastAt > QUIET_AFTER_MS;
  const ago = formatDurationMs(now - lastAt);
  return (
    <span
      role="img"
      aria-label={`Last activity ${ago} ago`}
      title={`Last activity ${ago} ago`}
      className={`inline-block size-2 rounded-full align-middle ${quiet ? "bg-amber-400" : "animate-pulse bg-emerald-400"}`}
    />
  );
}
