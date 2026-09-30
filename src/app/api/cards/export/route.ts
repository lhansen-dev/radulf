import { exportCards, exportFileName } from "@/server/cardTransfer";
import { handle } from "../../_lib";

/**
 * GET /api/cards/export?cardId=… or ?repoId=… — the cards as a JSON file.
 *
 * Returned with a filename rather than as a plain JSON body: this exists to
 * be saved, and a browser given `Content-Disposition` saves it instead of
 * rendering it.
 */
export async function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    const exported = exportCards({
      cardId: url.searchParams.get("cardId") ?? undefined,
      repoId: url.searchParams.get("repoId") ?? undefined,
    });
    return new Response(JSON.stringify(exported, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${exportFileName(exported)}"`,
      },
    });
  });
}
