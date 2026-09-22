import { record } from "@/server/requestValidation";
import { scopingTurn } from "@/server/scoping";
import { json, err, handle } from "../../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/cards/:id/scoping — one turn of the card's scoping thread (spec 17).
 * Body: { content: string, reply?: boolean }. Returns the whole thread. */
export async function POST(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const body = record(await req.json(), "scoping body");
    if (typeof body.content !== "string") return err("content is required");
    if (body.reply !== undefined && typeof body.reply !== "boolean") return err("reply must be a boolean");
    return json({ messages: await scopingTurn(id, body.content, { reply: body.reply }) });
  });
}
