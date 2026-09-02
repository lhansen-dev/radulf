import { eq, max, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, cards, repos, runs, now } from "@/db";
import { getSettings } from "@/server/settings";
import { modelTag } from "@/server/modelTag";
import { getOrchestrator } from "@/server/orchestrator";
import { listBranches } from "@/server/git";
import { currentTaskFromFile } from "@/server/currentTask";
import { planStatePath } from "@/server/bookkeeping";
import { parseCreateCard } from "@/server/cardValidation";
import { emitEvent } from "@/server/events";
import { json, err, handle } from "../_lib";

export const dynamic = "force-dynamic";

/** Board payload: every card plus what its column badge needs. */
export async function GET() {
  const settings = getSettings();
  const allCards = db.select().from(cards).all();
  const allRepos = new Map(db.select().from(repos).all().map((r) => [r.id, r]));
  // One row per card — SQLite's bare-column MAX() picks the newest run's id,
  // so the board never scans the full run history.
  const latestRuns = new Map(
    db
      .select()
      .from(runs)
      .where(
        sql`${runs.id} in (select id from (select id, max(started_at) from runs group by card_id))`,
      )
      .all()
      .map((run) => [run.cardId, run]),
  );

  const out = allCards.map((card) => {
    const repo = allRepos.get(card.repoId);
    const latestRun = latestRuns.get(card.id);
    return {
      ...card,
      repoName: repo?.name ?? "?",
      latestRun: latestRun
        ? {
            id: latestRun.id,
            kind: latestRun.kind,
            status: latestRun.status,
            iterationsDone: latestRun.iterationsDone,
            exitReason: latestRun.exitReason,
            startedAt: latestRun.startedAt,
            currentTask: card.status === "looping"
              ? currentTaskFromFile(planStatePath(card.id))
              : null,
          }
        : null,
      maxIterationsResolved: card.maxIterations ?? settings.defaultMaxIterations,
      // Effective planner model: per-card override, else the global setting.
      // Empty means "provider default" (e.g. the Claude subscription default).
      plannerModelResolved: modelTag(settings.plannerProvider, card.plannerModel || settings.plannerModel || null),
      // Effective loop (Ralpher) model: per-card override, else the global setting.
      // Empty means "provider default" (e.g. the Claude subscription default).
      loopModelResolved: modelTag(settings.loopProvider, card.loopModel || settings.loopModel || null),
      // Effective evaluator model: per-card override, else the global setting.
      // Empty means "provider default" (e.g. the Claude subscription default).
      evaluatorModelResolved: modelTag(settings.evaluatorProvider, card.evaluatorModel || settings.evaluatorModel || null),
      summary: card.summary,
    };
  });
  return json(out);
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = parseCreateCard(await req.json());
    const repo = db.select().from(repos).where(eq(repos.id, body.repoId)).get();
    if (!repo) return err("repoId does not exist");
    if (body.baseBranch && !(await listBranches(repo.path)).includes(body.baseBranch)) {
      return err("baseBranch does not exist in the repository");
    }

    const maxPos =
      db
        .select({ max: max(cards.position) })
        .from(cards)
        .where(eq(cards.status, "backlog"))
        .get()?.max ?? 0;

    const row = db
      .insert(cards)
      .values({
        id: nanoid(),
        repoId: body.repoId,
        title: body.title,
        description: body.description,
        status: "backlog",
        position: maxPos + 1,
        maxIterations: body.maxIterations,
        timeoutMinutes: body.timeoutMinutes,
        plannerModel: body.plannerModel,
        loopModel: body.loopModel,
        evaluatorModel: body.evaluatorModel,
        reviewPlanBeforeImplementation: body.reviewPlanBeforeImplementation === true ? 1 : 0,
        autoApprove: body.autoApprove === true ? 1 : 0,
        openPr: body.openPr === true ? 1 : 0,
        baseBranch: body.baseBranch,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning()
      .get();
    emitEvent("card.created", { cardId: row.id, payload: { title: body.title } });
    getOrchestrator().pump();
    return json(row, 201);
  });
}
