import { importCards } from "@/server/cardTransfer";
import { record } from "@/server/requestValidation";
import { json, err, handle } from "../../_lib";

/**
 * POST /api/cards/import — create the cards in a file, in Backlog.
 *
 * Body: `{ repoId, ...theExportedFile }`. The file names the repository it
 * came from only as a hint; the repository the cards land in is this
 * request's to choose, because an id from another install means nothing here.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const body = record(await req.json(), "import body");
    const repoId = typeof body.repoId === "string" ? body.repoId.trim() : "";
    if (!repoId) return err("repoId is required");
    return json(await importCards(repoId, body), 201);
  });
}
