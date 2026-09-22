import { eq } from "drizzle-orm";
import { db, cards, now } from "@/db";
import { requireCard } from "@/server/cards";
import { getOrchestrator } from "@/server/orchestrator";
import { record } from "@/server/requestValidation";
import { PULLBACK_STATUSES } from "@/shared/cardStatus";
import { json, err, handle } from "../../../_lib";

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
        // Must be finite: Infinity/NaN slip past typeof and, once persisted,
        // poison every later queueCard position (max(position) + 1 stays Infinity forever).
        if (typeof body.position !== "number" || !Number.isFinite(body.position)) {
          return err("position must be a finite number");
        }
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
      if (PULLBACK_STATUSES.includes(card.status)) {
        orch.cancelCard(id);
        return json({ ok: true });
      }
      return err(`cannot pull a ${card.status} card back to Backlog`);
    }

    return err(`illegal move target: ${to}`);
  });
}
