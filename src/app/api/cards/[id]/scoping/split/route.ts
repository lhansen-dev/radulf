import { getOrchestrator } from "@/server/orchestrator";
import { json, handle } from "../../../../_lib";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/cards/:id/scoping/split — ask the session to break the card's
 * work into ordered pieces (spec 17), with the run mode it recommends for
 * them (spec 24). A proposal only: applying the operator's version of it is
 * POST /api/cards/:id/breakdown, which is also where Jira's pieces arrive.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(async () => json(await getOrchestrator().proposeScopingSplit(id)));
}
