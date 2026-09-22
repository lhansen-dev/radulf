import { eq, inArray } from "drizzle-orm";
import { db, cards, now } from "@/db";
import { getOrchestrator } from "@/server/orchestrator";
import { json, handle } from "../_lib";

// `next dev`'s CLI parent respawns the server child when it exits with this
// code — the same hook it uses to restart itself on next.config changes
// (RESTART_EXIT_CODE in next/dist/server/lib/utils). Under `next start`
// there is no supervisor, so this just stops the process.
const NEXT_RESTART_EXIT_CODE = 77;

const IN_PROGRESS = ["planning", "ready", "looping", "evaluating"] as const;

export async function POST() {
  return handle(async () => {
    const orch = getOrchestrator();
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
    // Let the response flush and the aborted claude children die first.
    setTimeout(() => process.exit(NEXT_RESTART_EXIT_CODE), 500);
    return json({ ok: true });
  });
}
