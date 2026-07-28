import fs from "node:fs";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db, cards, plans, runs, iterations, reviews, events, repos } from "@/db";
import { now } from "@/db";
import { planStatePath } from "@/server/bookkeeping";
import { parseUpdateCard } from "@/server/cardValidation";
import { groupBy } from "@/server/queryGrouping";
import { removeRunTranscripts } from "@/server/retention";
import { json, err, handle } from "../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Full card detail: plans, runs (+iterations), reviews, recent events. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const card = db.select().from(cards).where(eq(cards.id, id)).get();
  if (!card) return err("card not found", 404);
  const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get();
  const cardPlans = db
    .select()
    .from(plans)
    .where(eq(plans.cardId, id))
    .orderBy(desc(plans.version))
    .all();
  const runRows = db
    .select()
    .from(runs)
    .where(eq(runs.cardId, id))
    .orderBy(desc(runs.startedAt))
    .limit(100)
    .all();
  const runIds = runRows.map((run) => run.id);
  const iterationRows = runIds.length === 0
    ? []
    : db
        .select()
        .from(iterations)
        .where(inArray(iterations.runId, runIds))
        .orderBy(asc(iterations.runId), asc(iterations.n))
        .all();
  const reviewRows = runIds.length === 0
    ? []
    : db.select().from(reviews).where(inArray(reviews.runId, runIds)).all();
  const iterationsByRun = groupBy(iterationRows, (iteration) => iteration.runId);
  const reviewsByRun = groupBy(reviewRows, (review) => review.runId);
  const cardRuns = runRows.map((run) => ({
      ...run,
      iterations: iterationsByRun.get(run.id) ?? [],
      reviews: reviewsByRun.get(run.id) ?? [],
    }));
  // Fetch the latest 100 events (descending id), then reverse for oldest-first display
  const cardEvents = db
    .select()
    .from(events)
    .where(eq(events.cardId, id))
    .orderBy(desc(events.id))
    .limit(100)
    .all()
    .reverse();
  return json({ card, repo, plans: cardPlans, runs: cardRuns, events: cardEvents });
}

export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const patch: Partial<typeof cards.$inferInsert> = {
      ...parseUpdateCard(await req.json()),
      updatedAt: now(),
    };
    const row = db.update(cards).set(patch).where(eq(cards.id, id)).returning().get();
    return row ? json(row) : err("card not found", 404);
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const card = db.select().from(cards).where(eq(cards.id, id)).get();
    if (!card) return err("card not found", 404);
    if (["planning", "looping", "evaluating"].includes(card.status))
      return err("cannot delete a card with an active run — pull it back to Backlog first");
    // Clean up any leftover worktree before the rows cascade away.
    const { getOrchestrator } = await import("@/server/orchestrator");
    const run = getOrchestrator().latestWorktreeRun(id);
    if (run) {
      const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get();
      if (repo) {
        const { removeWorktree } = await import("@/server/git");
        await removeWorktree(repo.path, run.worktreePath, run.branch);
      }
    }
    const runIds = db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.cardId, id))
      .all()
      .map((item) => item.id);
    removeRunTranscripts(runIds);
    fs.rmSync(/* turbopackIgnore: true */ planStatePath(id), { force: true });
    db.delete(events).where(eq(events.cardId, id)).run();
    db.delete(cards).where(eq(cards.id, id)).run();
    return json({ ok: true });
  });
}
