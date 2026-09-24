import { eq } from "drizzle-orm";
import { db, cards, repos, runs } from "@/db";
import { assertBranchExists, assertUsableRepo } from "@/server/git";
import { getOrchestrator } from "@/server/orchestrator";
import { getRepo, parseGateCommand, requireRepo } from "@/server/repos";
import { record } from "@/server/requestValidation";
import { removeCardArtifacts } from "@/server/retention";
import { json, err, handle } from "../../_lib";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const row = getRepo(id);
  return row ? json(row) : err("repo not found", 404);
}

export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const body = record(await req.json(), "repo body");
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
    // Spec 27: present means set, blank or null means clear.
    if ("gateCommand" in body) patch.gateCommand = parseGateCommand(body.gateCommand);
    if (Object.keys(patch).length === 0) return err("nothing to update");
    const row = db.update(repos).set(patch).where(eq(repos.id, id)).returning().get();
    return row ? json(row) : err("repo not found", 404);
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const repo = requireRepo(id);
    const orchestrator = getOrchestrator();
    // The same cleanup deleting a card does, for every card of the repo.
    // Cascading the rows loses the paths it needs, so gather them first; the
    // disk work waits until after the delete, because the guard and the delete
    // stay together with no await between them, so no run can start after the
    // check passes and before the rows cascade away.
    const artifacts = db
      .select({ id: cards.id })
      .from(cards)
      .where(eq(cards.repoId, id))
      .all()
      .map((card) => ({
        cardId: card.id,
        worktreeRun: orchestrator.latestWorktreeRun(card.id),
        runIds: db
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.cardId, card.id))
          .all()
          .map((row) => row.id),
      }));
    orchestrator.assertRepoRemovable(id);
    db.delete(repos).where(eq(repos.id, id)).run();
    for (const card of artifacts) await removeCardArtifacts(repo.path, card);
    return json({ ok: true });
  });
}
