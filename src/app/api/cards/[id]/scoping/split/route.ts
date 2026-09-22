import { getOrchestrator } from "@/server/orchestrator";
import { record } from "@/server/requestValidation";
import { json, err, handle } from "../../../../_lib";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/cards/:id/scoping/split — the card's work is more than one card
 * (spec 17).
 *
 * With no body, the session proposes the split and nothing is applied. With
 * `{ cards: [...] }` the operator's own version of the proposal is applied:
 * this card becomes the first piece and the rest are queued after it. Two
 * verbs on one route because they are one decision, and the proposal a POST
 * returns is exactly the body the apply takes back.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(async () => {
    const orch = getOrchestrator();
    const body = req.headers.get("content-length") === "0" ? {} : await req.json().catch(() => ({}));
    if (!("cards" in record(body, "split body"))) {
      return json(await orch.proposeScopingSplit(id));
    }
    const items = (body as { cards: unknown }).cards;
    if (!Array.isArray(items)) return err("cards must be an array");
    for (const item of items) {
      const card = record(item, "split card");
      if (typeof card.title !== "string" || typeof card.description !== "string") {
        return err("every split card needs a title and a description");
      }
    }
    return json({ cards: orch.applyScopingSplit(id, items as { title: string; description: string }[]) });
  });
}
