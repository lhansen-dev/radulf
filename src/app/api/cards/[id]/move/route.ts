import { eq } from "drizzle-orm";
import { db, cards, now } from "@/db";
import { requireCard } from "@/server/cards";
import { getOrchestrator } from "@/server/orchestrator";
import { record } from "@/server/requestValidation";
import { json, err, handle } from "../../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The only drags a human is allowed:
 *  - backlog → todo         add to the auto-mode queue
 *  - todo → todo            reorder ({to:"todo", position})
 *  - todo → in_progress     start the pipeline
 *  - needs_attention → in_progress   restart
 *  - todo/planning/ready/looping/evaluating/review/plan_review/
 *    needs_attention → backlog   pull back (cancels live runs)
 */
export async function POST(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const body = record(await req.json(), "move body");
    const to = String(body.to ?? "");
    const card = requireCard(id);
    const orch = getOrchestrator();

    // startCard accepts todo and needs_attention, queueCard only backlog;
    // both throw the ClientError for anything else.
    if (to === "in_progress") {
      orch.startCard(id);
      return json({ ok: true });
    }

    if (to === "todo") {
      if (card.status === "todo") {
        if (typeof body.position !== "number") return err("position required for reorder");
        db.update(cards)
          .set({ position: body.position, updatedAt: now() })
          .where(eq(cards.id, id))
          .run();
      } else {
        orch.queueCard(id);
      }
      return json({ ok: true });
    }

    if (to === "backlog") {
      if (["todo", "planning", "ready", "looping", "evaluating", "review", "plan_review", "needs_attention", "paused"].includes(card.status)) {
        orch.cancelCard(id);
        return json({ ok: true });
      }
      return err(`cannot pull a ${card.status} card back to Backlog`);
    }

    return err(`illegal move target: ${to}`);
  });
}
