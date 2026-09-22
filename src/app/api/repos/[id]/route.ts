import fs from "node:fs";
import { eq } from "drizzle-orm";
import { db, cards, repos, runs } from "@/db";
import { planStatePath } from "@/server/bookkeeping";
import { assertBranchExists, assertUsableRepo, removeWorktree } from "@/server/git";
import { getRepo, requireRepo } from "@/server/repos";
import { removeRunTranscripts } from "@/server/retention";
import { json, err, handle } from "../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const row = getRepo(id);
  return row ? json(row) : err("repo not found", 404);
}

export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const body = await req.json();
    const current = requireRepo(id);
    const patch: Partial<typeof repos.$inferInsert> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.path === "string" && body.path.trim()) {
      await assertUsableRepo(body.path.trim());
      patch.path = body.path.trim();
    }
    if (typeof body.defaultBranch === "string" && body.defaultBranch.trim()) {
      await assertBranchExists(patch.path ?? current.path, body.defaultBranch.trim(), "defaultBranch");
      patch.defaultBranch = body.defaultBranch.trim();
    }
    if (Object.keys(patch).length === 0) return err("nothing to update");
    const row = db.update(repos).set(patch).where(eq(repos.id, id)).returning().get();
    return row ? json(row) : err("repo not found", 404);
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const repo = requireRepo(id);
    const { getOrchestrator } = await import("@/server/orchestrator");
    const orchestrator = getOrchestrator();
    // The same cleanup deleting a card does, for every card of the repo.
    // Cascading the rows loses the paths it needs, so gather them first; the
    // disk work waits until after the delete, because the guard and the delete
    // stay together with no await between them, so no run can start after the
    // check passes and before the rows cascade away.
    const repoCards = db.select({ id: cards.id }).from(cards).where(eq(cards.repoId, id)).all();
    const worktreeRuns = repoCards.flatMap((card) => orchestrator.latestWorktreeRun(card.id) ?? []);
    const runIds = db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(cards, eq(runs.cardId, cards.id))
      .where(eq(cards.repoId, id))
      .all()
      .map((row) => row.id);
    orchestrator.assertRepoRemovable(id);
    db.delete(repos).where(eq(repos.id, id)).run();
    for (const run of worktreeRuns) await removeWorktree(repo.path, run.worktreePath, run.branch);
    removeRunTranscripts(runIds);
    for (const card of repoCards) fs.rmSync(/* turbopackIgnore: true */ planStatePath(card.id), { force: true });
    return json({ ok: true });
  });
}
