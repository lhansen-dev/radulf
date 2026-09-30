import { eq, inArray } from "drizzle-orm";
import { db, cards, now } from "@/db";
import { getOrchestrator } from "@/server/orchestrator";
import { sleep } from "@/shared/sleep";
import { json, handle } from "../_lib";

// `next dev`'s CLI parent respawns the server child when it exits with this
// code — the same hook it uses to restart itself on next.config changes
// (RESTART_EXIT_CODE in next/dist/server/lib/utils). Under `next start`
// there is no supervisor, so this just stops the process.
const NEXT_RESTART_EXIT_CODE = 77;

const IN_PROGRESS = ["planning", "ready", "looping", "evaluating"] as const;

/** Long enough for the response to reach the browser before the socket dies. */
const RESPONSE_FLUSH_MS = 500;
/**
 * How long to wait for the cancelled runs to actually be gone.
 *
 * `cancelCard` aborts the harness; the agent it spawned is a process tree of
 * its own, and on a host install nothing kills that tree — it unwinds when
 * the abort reaches it. A flat half-second was not that wait: the process
 * exited while a `claude` was still writing to a worktree, `next dev`
 * respawned immediately, and the replacement's `recover()` reconciled a
 * worktree that a surviving agent was still editing. Wait for the
 * orchestrator to report itself idle instead, bounded so a wedged child
 * cannot make Restart a button that does nothing.
 */
const REAP_TIMEOUT_MS = 15_000;
const REAP_POLL_MS = 250;

export async function POST() {
  return handle(async () => {
    const orch = getOrchestrator();
    // Stop the pump before the sweep: cancelCard pumps the queue itself, and
    // a promotion landing between the sweep and the exit is a run started by
    // a process that is about to die.
    orch.startDraining();
    // Cancel every In Progress card back to Backlog before dying, so nothing is
    // mid-run when the process exits. This route typically runs while the
    // live schema is OLDER than the code (that's what restarts are for), so
    // select only the columns the sweep needs — a bare select() would query
    // not-yet-migrated columns and 500. cancelCard pumps the queue after each
    // cancel and may promote a ready card to looping, so sweep until clear.
    for (let guard = 0; guard < 10; guard++) {
      const active = db
        .select({ id: cards.id })
        .from(cards)
        .where(inArray(cards.status, [...IN_PROGRESS]))
        .all();
      if (active.length === 0) break;
      for (const card of active) {
        try {
          orch.cancelCard(card.id);
        } catch {
          // cancelCard reads full card rows, which can hit the same outdated
          // schema — fall back to a bare status flip; boot recovery marks the
          // orphaned run interrupted and leaves backlog cards alone.
          db.update(cards)
            .set({ status: "backlog", startedAt: null, updatedAt: now() })
            .where(eq(cards.id, card.id))
            .run();
        }
      }
    }
    // Let the response flush, then wait for the aborted agents to be gone.
    setTimeout(() => void exitWhenReaped(orch), RESPONSE_FLUSH_MS);
    return json({ ok: true });
  });
}

async function exitWhenReaped(orch: { hasInFlightWork(): boolean }): Promise<void> {
  const deadline = Date.now() + REAP_TIMEOUT_MS;
  while (orch.hasInFlightWork() && Date.now() < deadline) await sleep(REAP_POLL_MS);
  if (orch.hasInFlightWork()) {
    console.log("[radulf] restart: a run is still in flight after the reap wait — exiting anyway");
  }
  process.exit(NEXT_RESTART_EXIT_CODE);
}
