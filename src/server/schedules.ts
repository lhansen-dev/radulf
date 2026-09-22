/**
 * Scheduled work (spec 22): the two things that want to happen unattended.
 *
 * A schedule starts only what a button starts, by the path a button takes —
 * `startCard` for a queue drain, `createImprovementRun` for a run — so every
 * cap either of those enforces still applies, and hard rule 1 of spec 06 (no
 * merge without a review row) is untouched.
 *
 * `fireDueSchedules` is the whole scheduler. A missed tick is missed, not
 * replayed: a server that was down at 03:00 must not drain the queue into the
 * middle of a working day when it boots at 09:00.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { cards, db, now, schedules, SCHEDULE_KINDS, type ScheduleKind } from "@/db";
import { ClientError } from "./clientError";
import { cronError, cronMatches, nextCronFire, parseCron } from "./cron";
import { emitEvent } from "./events";
import { createImprovementRun } from "./improvementRuns";
import { getOrchestrator } from "./orchestrator";
import { getRepo } from "./repos";
import { errorMessage } from "@/shared/errorMessage";

export type Schedule = typeof schedules.$inferSelect;

/**
 * An improvement-run schedule's stored arguments: the same set the Start
 * improvement run dialog collects, less the repo, which is the schedule's own
 * column.
 */
export type ImprovementRunConfig = {
  baseBranch: string;
  budgetMinutes: number;
  focusPrompt?: string;
  plannerModel?: string;
  loopModel?: string;
  evaluatorModel?: string;
  plannerReasoning?: string;
  loopReasoning?: string;
  evaluatorReasoning?: string;
  maxIterations?: number;
  timeoutMinutes?: number;
};

export type ScheduleInput = {
  kind: ScheduleKind;
  repoId: string | null;
  cron: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
};

/** How many upcoming fire times a listing carries. */
const UPCOMING = 3;

/**
 * Every schedule, oldest first, each with the next few times it will fire.
 *
 * The times are how a cron expression is read back to the operator (spec 22):
 * three concrete timestamps say what `0 3 * * 1-5` means far more reliably
 * than a prose rendering of it would, and they are the same computation the
 * ticker uses.
 */
export function listSchedules(from = new Date()): (Schedule & { upcoming: string[] })[] {
  return db
    .select()
    .from(schedules)
    .orderBy(asc(schedules.createdAt))
    .all()
    .map((row) => ({ ...row, upcoming: upcomingFires(row, from) }));
}

function upcomingFires(row: Schedule, from: Date): string[] {
  if (!row.enabled) return [];
  let cron;
  try {
    cron = parseCron(row.cron);
  } catch {
    return []; // a stored expression that no longer parses simply never fires
  }
  const times: string[] = [];
  let after = from;
  for (let i = 0; i < UPCOMING; i++) {
    const next = nextCronFire(cron, after);
    if (!next) break;
    times.push(next.toISOString());
    after = new Date(next.getTime() + 60_000);
  }
  return times;
}

export function createSchedule(input: ScheduleInput): Schedule {
  const { kind, repoId, cron, config } = validate(input);
  const row = db
    .insert(schedules)
    .values({
      id: nanoid(),
      kind,
      repoId,
      cron,
      enabled: input.enabled === false ? 0 : 1,
      config: JSON.stringify(config),
      createdAt: now(),
      updatedAt: now(),
    })
    .returning()
    .get();
  emitEvent("schedule.created", { payload: { scheduleId: row.id, kind, cron, repoId } });
  return row;
}

export function updateSchedule(id: string, patch: Partial<ScheduleInput>): Schedule {
  const existing = requireSchedule(id);
  const merged = validate({
    kind: patch.kind ?? existing.kind,
    repoId: patch.repoId === undefined ? existing.repoId : patch.repoId,
    cron: patch.cron ?? existing.cron,
    config: patch.config ?? (JSON.parse(existing.config) as Record<string, unknown>),
  });
  return db
    .update(schedules)
    .set({
      kind: merged.kind,
      repoId: merged.repoId,
      cron: merged.cron,
      config: JSON.stringify(merged.config),
      enabled: patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
      updatedAt: now(),
    })
    .where(eq(schedules.id, id))
    .returning()
    .get();
}

export function deleteSchedule(id: string): void {
  requireSchedule(id);
  db.delete(schedules).where(eq(schedules.id, id)).run();
}

export function requireSchedule(id: string): Schedule {
  const row = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!row) throw new ClientError("schedule not found", 404);
  return row;
}

function validate(input: ScheduleInput) {
  if (!SCHEDULE_KINDS.includes(input.kind)) {
    throw new ClientError(`kind must be one of ${SCHEDULE_KINDS.join(", ")}`);
  }
  const problem = cronError(input.cron);
  if (problem) throw new ClientError(problem);
  const repoId = input.repoId || null;
  if (repoId && !getRepo(repoId)) throw new ClientError("repoId does not exist");
  const config = input.config ?? {};
  if (input.kind === "queue-drain") {
    // A drain takes no arguments: it starts what is already queued.
    return { kind: input.kind, repoId, cron: input.cron.trim(), config: {} };
  }
  if (!repoId) throw new ClientError("an improvement-run schedule needs a repoId");
  const baseBranch = typeof config.baseBranch === "string" ? config.baseBranch.trim() : "";
  if (!baseBranch) throw new ClientError("an improvement-run schedule needs a baseBranch");
  const budgetMinutes = Number(config.budgetMinutes);
  if (!Number.isInteger(budgetMinutes) || budgetMinutes < 1 || budgetMinutes > 10_080) {
    throw new ClientError("budgetMinutes must be a whole number of minutes between 1 and 10080");
  }
  return {
    kind: input.kind,
    repoId,
    cron: input.cron.trim(),
    config: { ...config, baseBranch, budgetMinutes },
  };
}

/** What one firing did. `skipped` is an outcome, not a failure. */
export type FireResult = {
  scheduleId: string;
  outcome: "started" | "skipped" | "failed";
  detail: string;
};

/**
 * Fire every enabled schedule whose expression names `at`.
 *
 * Called once a minute. `lastFiredAt` is compared at minute resolution so a
 * tick that runs twice in the same minute — two overlapping timers, a clock
 * nudge — cannot start the same work twice.
 */
export async function fireDueSchedules(
  at = new Date(),
  deps: ScheduleDeps = defaultDeps,
): Promise<FireResult[]> {
  const minute = minuteKey(at);
  const due = db
    .select()
    .from(schedules)
    .where(eq(schedules.enabled, 1))
    .all()
    .filter((row) => minuteKey(row.lastFiredAt) !== minute && matchesNow(row, at));

  const results: FireResult[] = [];
  for (const row of due) {
    // Stamp before running, not after: an improvement run's creation awaits
    // git, and a tick that overlapped it would otherwise see the schedule as
    // unfired and start a second one.
    db.update(schedules).set({ lastFiredAt: at.toISOString() }).where(eq(schedules.id, row.id)).run();
    const result = await fireOne(row, deps);
    db.update(schedules)
      .set({
        lastResult: result.detail.slice(0, 500),
        lastError: result.outcome === "failed" ? result.detail.slice(0, 500) : null,
        updatedAt: now(),
      })
      .where(eq(schedules.id, row.id))
      .run();
    emitEvent("schedule.fired", {
      payload: {
        scheduleId: row.id,
        kind: row.kind,
        repoId: row.repoId,
        outcome: result.outcome,
        detail: result.detail,
      },
    });
    results.push(result);
  }
  return results;
}

function matchesNow(row: Schedule, at: Date): boolean {
  try {
    return cronMatches(parseCron(row.cron), at);
  } catch {
    return false;
  }
}

/** ISO down to the minute, or null. What "already fired this minute" compares. */
function minuteKey(value: string | Date | null): string | null {
  if (!value) return null;
  const iso = typeof value === "string" ? value : value.toISOString();
  return iso.slice(0, 16);
}

/**
 * The two starts, injected so the scheduler is testable without a planner or
 * a git checkout behind it.
 */
export type ScheduleDeps = {
  startCard: (cardId: string) => void;
  createImprovementRun: (input: ImprovementRunConfig & { repoId: string }) => Promise<unknown>;
};

const defaultDeps: ScheduleDeps = {
  startCard: (cardId) => getOrchestrator().startCard(cardId),
  createImprovementRun: (input) =>
    createImprovementRun({
      repoId: input.repoId,
      baseBranch: input.baseBranch,
      budgetMinutes: input.budgetMinutes,
      focusPrompt: input.focusPrompt,
      plannerModel: input.plannerModel,
      loopModel: input.loopModel,
      evaluatorModel: input.evaluatorModel,
      plannerReasoning: input.plannerReasoning,
      loopReasoning: input.loopReasoning,
      evaluatorReasoning: input.evaluatorReasoning,
      maxIterations: input.maxIterations,
      timeoutMinutes: input.timeoutMinutes,
    }),
};

async function fireOne(row: Schedule, deps: ScheduleDeps): Promise<FireResult> {
  try {
    return row.kind === "queue-drain" ? drainQueue(row, deps) : await startRun(row, deps);
  } catch (cause) {
    return { scheduleId: row.id, outcome: "failed", detail: errorMessage(cause) };
  }
}

/**
 * Start every card waiting in the Queue, which is what pressing Start on each
 * of them does. `startCard` stamps `startedAt`, and the pump then takes them
 * oldest manual start first, honouring the per-repo cap (spec 20); a card
 * that has already been started is left alone.
 */
function drainQueue(row: Schedule, deps: ScheduleDeps): FireResult {
  const queued = db
    .select({ id: cards.id })
    .from(cards)
    .where(
      and(
        eq(cards.status, "todo"),
        isNull(cards.startedAt),
        row.repoId ? eq(cards.repoId, row.repoId) : undefined,
      ),
    )
    .orderBy(asc(cards.position))
    .all();
  if (queued.length === 0) {
    return { scheduleId: row.id, outcome: "skipped", detail: "nothing waiting in the queue" };
  }
  // One card that will not start must not cost the rest of the queue its
  // drain, so each is tried on its own and the count is what actually went.
  let started = 0;
  const refused: string[] = [];
  for (const card of queued) {
    try {
      deps.startCard(card.id);
      started += 1;
    } catch (cause) {
      refused.push(errorMessage(cause));
    }
  }
  const detail = `started ${started} of ${queued.length} queued card${queued.length === 1 ? "" : "s"}` +
    (refused.length > 0 ? `; ${refused[0]}` : "");
  return { scheduleId: row.id, outcome: started > 0 ? "started" : "failed", detail };
}

/**
 * Start an improvement run with the schedule's stored arguments. A repo that
 * already has an active run is skipped: spec 06's one-active-per-repo rule is
 * not something a schedule may bend.
 */
async function startRun(row: Schedule, deps: ScheduleDeps): Promise<FireResult> {
  const config = JSON.parse(row.config) as ImprovementRunConfig;
  try {
    await deps.createImprovementRun({ ...config, repoId: row.repoId! });
    return { scheduleId: row.id, outcome: "started", detail: `improvement run on ${config.baseBranch}` };
  } catch (cause) {
    const message = errorMessage(cause);
    return /already active/.test(message)
      ? { scheduleId: row.id, outcome: "skipped", detail: message }
      : { scheduleId: row.id, outcome: "failed", detail: message };
  }
}
