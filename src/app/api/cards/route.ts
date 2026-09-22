import { eq, max, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, cards, repos, runs, now } from "@/db";
import { getSettings } from "@/server/settings";
import { modelTag } from "@/server/modelTag";
import { getOrchestrator } from "@/server/orchestrator";
import { getRepo } from "@/server/repos";
import { assertBranchExists, isRalphBranch } from "@/server/git";
import { readPlanState } from "@/server/bookkeeping";
import { firstUnchecked } from "@/server/checklist";
import { parseCreateCard } from "@/server/cardValidation";
import { emitEvent } from "@/server/events";
import { json, err, handle } from "../_lib";

/**
 * Where a looping card is in its checklist (upstream issue 34). The board used
 * to show the task's text alone, which answers "what is it doing" but not "how
 * much is left" — the card page has carried both per iteration since plan
 * versions landed, and a board watching several repos is where the question
 * actually gets asked. `left` counts the current task, which is not finished.
 */
function currentTask(cardId: string) {
  const task = firstUnchecked(readPlanState(cardId) ?? "");
  if (!task) return null;
  return {
    number: task.taskNumber,
    count: task.taskCount,
    left: task.taskCount - task.taskNumber + 1,
    text: task.item.text,
  };
}

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
            currentTask: card.status === "looping" ? currentTask(card.id) : null,
          }
        : null,
      maxIterationsResolved: card.maxIterations ?? settings.defaultMaxIterations,
      // Effective model per role: per-card override, else the global setting.
      // Empty means "provider default" (e.g. the Claude subscription default).
      ...Object.fromEntries(
        (["planner", "loop", "evaluator"] as const).map((role) => [
          `${role}ModelResolved`,
          modelTag(settings[`${role}Provider`], card[`${role}Model`] || settings[`${role}Model`] || null),
        ]),
      ),
    };
  });
  return json(out);
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = parseCreateCard(await req.json());
    const repo = getRepo(body.repoId);
    if (!repo) return err("repoId does not exist");
    if (body.baseBranch && isRalphBranch(body.baseBranch)) {
      return err("baseBranch cannot be one of Radulf's own ralph/* branches");
    }
    if (body.baseBranch) await assertBranchExists(repo.path, body.baseBranch, "baseBranch");

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
        reviewPlanBeforeImplementation: body.reviewPlanBeforeImplementation ? 1 : 0,
        grillMe: body.grillMe ? 1 : 0,
        scopingAuthorsPlan: body.scopingAuthorsPlan ? 1 : 0,
        autoApprove: body.autoApprove ? 1 : 0,
        openPr: body.openPr ? 1 : 0,
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
