import fs from "node:fs";
import path from "node:path";
import { requireCard } from "@/server/cards";
import { getOrchestrator } from "@/server/orchestrator";
import { doneFilePath } from "@/server/bookkeeping";
import { worktreeDiff, worktreeDiffStat } from "@/server/git";
import { requireRepo } from "@/server/repos";
import { json, err, handle } from "../../../_lib";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const card = requireCard(id);
    const repo = requireRepo(card.repoId);
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
