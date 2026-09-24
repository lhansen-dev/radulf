import fs from "node:fs";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db, cards, plans, runs, iterations, reviews, events } from "@/db";
import { now } from "@/db";
import { planStatePath } from "@/server/bookkeeping";
import { parseChecklist } from "@/server/checklist";
import { parseUpdateCard } from "@/server/cardValidation";
import { getCard, requireCard } from "@/server/cards";
import { listChildren } from "@/server/epics";
import { getOrchestrator } from "@/server/orchestrator";
import { getRepo, requireRepo } from "@/server/repos";
import { groupBy } from "@/server/queryGrouping";
import { removeCardArtifacts } from "@/server/retention";
import { listScopingMessages, scopingTurnInFlight } from "@/server/scoping";
import { getSettings } from "@/server/settings";
import { RUNNING_STATUSES } from "@/shared/cardStatus";
import { json, err, handle } from "../../_lib";

type Ctx = { params: Promise<{ id: string }> };

/** Full card detail: plans, runs (+iterations), reviews, recent events. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const card = getCard(id);
  if (!card) return err("card not found", 404);
  const repo = getRepo(card.repoId);
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
  // Effective provider+model per role: card override, else the global setting —
  // same resolution the harness itself applies (planningService/orchestrator/
  // evaluationService), so the overview shows what will actually run next.
  // Reasoning level has no per-card override and isn't persisted per run
  // (runHarness reads it straight off settings at call time), so this is
  // always the current global value, not necessarily what an old run used.
  const settings = getSettings();
  const models = Object.fromEntries(
    (["planner", "loop", "evaluator", "critic"] as const).map((role) => [role, {
      provider: settings[`${role}Provider`],
      model: card[`${role}Model`] || settings[`${role}Model`] || null,
      reasoningLevel: settings[`${role}ReasoningLevel`],
    }]),
  );
  // The orchestrator-private checklist the loop is ticking off — the latest
  // plan version as it stands right now, which its plan row can't show.
  const planPath = planStatePath(id);
  let livePlan: { planMd: string; done: number; total: number } | null = null;
  if (cardPlans.length > 0 && fs.existsSync(/* turbopackIgnore: true */ planPath)) {
    const planMd = fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8");
    const items = parseChecklist(planMd)?.items ?? [];
    livePlan = { planMd, done: items.filter((item) => item.checked).length, total: items.length };
  }
  // Spec 24: the epic this card is a piece of, and the pieces it has.
  const parent = card.parentCardId ? getCard(card.parentCardId) : undefined;
  return json({
    card, repo, plans: cardPlans, livePlan, runs: cardRuns, events: cardEvents, models,
    scoping: listScopingMessages(id),
    scopingTurn: scopingTurnInFlight(id),
    children: listChildren(id),
    parent: parent ? { id: parent.id, title: parent.title, runMode: parent.runMode } : null,
  });
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
    const card = requireCard(id);
    if (RUNNING_STATUSES.includes(card.status))
      return err("cannot delete a card with an active run — pull it back to Backlog first");
    // Clean up any leftover worktree before the rows cascade away.
    const runIds = db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.cardId, id))
      .all()
      .map((item) => item.id);
    await removeCardArtifacts(requireRepo(card.repoId).path, {
      cardId: id,
      worktreeRun: getOrchestrator().latestWorktreeRun(id),
      runIds,
    });
    db.delete(events).where(eq(events.cardId, id)).run();
    db.delete(cards).where(eq(cards.id, id)).run();
    return json({ ok: true });
  });
}
