import { getOrchestrator } from "@/server/orchestrator";
import { json, handle } from "../../../../_lib";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/cards/:id/scoping/plan — the card's scoping session writes its
 * plan artifacts and the planning stage is skipped (spec 17).
 *
 * Applied rather than proposed, unlike a split: the plan-review gate the card
 * already carries (`reviewPlanBeforeImplementation`) is where a human reads a
 * plan, so a second approval step here would be a second code path for the
 * same decision. Refused unless the card opted in.
 */
export async function POST(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    return json(await getOrchestrator().adoptScopingPlan(id));
  });
}
