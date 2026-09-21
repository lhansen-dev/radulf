import { proposeScopedCard } from "@/server/scoping";
import { json, handle } from "../../../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/cards/:id/scoping/proposal — write the scoped card from the
 * thread (spec 17). Returns { title, description, messages }; nothing is
 * applied to the card until the operator saves it. */
export async function POST(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    return json(await proposeScopedCard(id));
  });
}
