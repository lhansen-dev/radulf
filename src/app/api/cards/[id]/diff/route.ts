import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, cards, repos } from "@/db";
import { getOrchestrator, doneFilePath } from "@/server/orchestrator";
import { worktreeDiff, worktreeDiffStat } from "@/server/git";
import { json, err, handle } from "../../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const card = db.select().from(cards).where(eq(cards.id, id)).get();
    if (!card) return err("card not found", 404);
    const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get();
    if (!repo) return err("repo not found", 404);
    const run = getOrchestrator().latestWorktreeRun(id);
    if (!run) return err("no worktree found for this card", 404);
    const donePath = doneFilePath(path.join(run.worktreePath, ".ralph"));
    const evaluationPath = path.join(run.worktreePath, ".ralph", "EVALUATION.md");
    const baseBranch = run.baseBranch ?? repo.defaultBranch;
    const [diff, stat] = await Promise.all([
      worktreeDiff(run.worktreePath, baseBranch),
      worktreeDiffStat(run.worktreePath, baseBranch),
    ]);
    return json({
      runId: run.id,
      branch: run.branch,
      diff,
      stat,
      done: donePath ? fs.readFileSync(donePath, "utf8") : null,
      evaluation: fs.existsSync(evaluationPath) ? fs.readFileSync(evaluationPath, "utf8") : null,
    });
  });
}
