import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { db, runs, iterations, TRANSCRIPTS_DIR } from "@/db";
import { json, err, handle } from "../../_lib";
import { readTranscriptChunk } from "@/server/transcript";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/runs/[id]            → run + iteration rows
 * GET /api/runs/[id]?iteration=N → parsed transcript lines for iteration N
 *                                  (N ignored for plan runs — returns plan.jsonl)
 */
export async function GET(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const run = db.select().from(runs).where(eq(runs.id, id)).get();
    if (!run) return err("run not found", 404);

    const searchParams = new URL(req.url).searchParams;
    const iterParam = searchParams.get("iteration");
    if (iterParam === null) {
      const iters = db
        .select()
        .from(iterations)
        .where(eq(iterations.runId, id))
        .orderBy(asc(iterations.n))
        .all();
      return json({ run, iterations: iters });
    }

    // Single-transcript run kinds; loop runs have one file per iteration.
    const singleFile: Partial<Record<typeof run.kind, string>> = {
      plan: "plan.jsonl",
      evaluate: "evaluate.jsonl",
    };
    const iteration = Number(iterParam);
    if (!singleFile[run.kind] && (!Number.isInteger(iteration) || iteration < 1)) {
      return err("iteration must be a positive integer");
    }
    const cursorParam = searchParams.get("cursor");
    const cursor = cursorParam === null ? null : Number(cursorParam);
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) {
      return err("cursor must be a non-negative integer");
    }

    const fileName =
      singleFile[run.kind] ?? `iter-${String(iteration).padStart(3, "0")}.jsonl`;
    const transcriptPath = path.join(
      /* turbopackIgnore: true */ TRANSCRIPTS_DIR,
      id,
      fileName,
    );
    const chunk = await readTranscriptChunk(transcriptPath, cursor, run.status === "running");
    return json({ run, ...chunk });
  });
}
