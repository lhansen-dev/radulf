import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  db,
  now,
  cards,
  plans,
  runs,
  reviews,
  repos,
  type CardStatus,
} from "@/db";
import { emitEvent } from "./events";
import {
  mergeBaseIntoWorktree,
  mergeBranch,
  removeWorktree,
} from "./git";
import { planStatePath } from "./bookkeeping";
import { appendTask } from "./checklist";
import { ClientError } from "./clientError";
import { checkRepoIntegrity, loadBaseline, removeBaseline } from "./integrity";

/** Every iteration runs on an injected checklist task, so feedback re-entry
 * must append one to the private plan — a prompt preamble alone never runs. */
function appendFeedbackTask(cardId: string, text: string) {
  const planPath = planStatePath(cardId);
  if (!fs.existsSync(/* turbopackIgnore: true */ planPath)) return;
  fs.writeFileSync(
    /* turbopackIgnore: true */ planPath,
    appendTask(fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8"), text),
  );
}

type Card = typeof cards.$inferSelect;
type Plan = typeof plans.$inferSelect;
type Run = typeof runs.$inferSelect;
type Repo = typeof repos.$inferSelect;

export type ReviewServiceDependencies = {
  getCard(cardId: string): Card | undefined;
  latestPlan(cardId: string): Plan | undefined;
  latestWorktreeRun(cardId: string): Run | undefined;
  moveCard(
    cardId: string,
    from: CardStatus,
    to: CardStatus,
    reason?: string,
  ): boolean;
  pump(): void;
};

/**
 * Owns human review state transitions and their Git/filesystem side effects.
 * Queue scheduling and child-process execution stay behind injected callbacks,
 * which keeps the review state machine independently testable.
 */
export class ReviewService {
  constructor(private readonly dependencies: ReviewServiceDependencies) {}

  /** Approve a plan_review card and hand it back to the loop queue. */
  approvePlan(cardId: string): { ok: boolean; error?: string } {
    const card = this.dependencies.getCard(cardId);
    if (!card) throw new ClientError("card not found");
    if (card.status !== "plan_review") {
      throw new ClientError(`cannot approve plan for card in status ${card.status}`);
    }
    this.dependencies.moveCard(cardId, "plan_review", "ready");
    this.dependencies.pump();
    return { ok: true };
  }

  async approve(runId: string): Promise<{ ok: boolean; error?: string }> {
    const existing = this.reviewForRun(runId);
    if (existing) {
      if (existing.decision === "approved") return { ok: true };
      throw new ClientError("run was already rejected");
    }
    return this.approveClaimedRun(runId, "review");
  }

  /** Retry only the merge for a completed loop whose first merge failed. */
  async retryMerge(cardId: string): Promise<{ ok: boolean; error?: string }> {
    const card = this.dependencies.getCard(cardId);
    if (!card) throw new ClientError("card not found");
    if (card.status !== "needs_attention") {
      throw new ClientError(`cannot retry merge for card in status ${card.status}`);
    }
    const run = this.latestLoopRun(cardId);
    if (
      !run ||
      run.status !== "completed" ||
      !fs.existsSync(/* turbopackIgnore: true */ run.worktreePath)
    ) {
      throw new ClientError("no completed loop run to merge — restart the card instead");
    }
    const evaluation = db
      .select()
      .from(runs)
      .where(and(eq(runs.cardId, cardId), eq(runs.kind, "evaluate")))
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get();
    if (
      evaluation &&
      !(
        evaluation.status === "completed" &&
        (evaluation.exitReason === "approve" ||
          evaluation.exitReason === "revise — revision limit reached")
      )
    ) {
      throw new ClientError("the evaluator has not cleared this loop run for merging");
    }
    const existing = this.reviewForRun(run.id);
    if (existing?.decision === "approved") return { ok: true };
    if (existing) throw new ClientError("run was already rejected");
    return this.approveClaimedRun(run.id, "needs_attention");
  }

  reject(runId: string, feedback: string) {
    if (!feedback.trim()) throw new ClientError("feedback is required to reject");
    const existing = this.reviewForRun(runId);
    if (existing) {
      if (existing.decision === "rejected") return;
      throw new ClientError("run was already approved");
    }
    const { run, card } = this.claimReviewRun(runId, "review");
    const plan = this.dependencies.latestPlan(card.id);
    if (!plan) {
      this.dependencies.moveCard(card.id, "reviewing", "review", "review operation failed");
      throw new ClientError("card has no plan");
    }

    const reviewId = nanoid();
    const planId = nanoid();
    const promptMd = `## Reviewer feedback — address this first\n\n${feedback.trim()}\n\n---\n\n${plan.promptMd}`;
    try {
      db.insert(reviews)
        .values({ id: reviewId, runId, decision: "rejected", feedback, createdAt: now() })
        .run();
      db.insert(plans)
        .values({
          id: planId,
          cardId: card.id,
          version: plan.version + 1,
          planMd: plan.planMd,
          promptMd,
          acceptanceCriteria: plan.acceptanceCriteria,
          feedback,
          createdAt: now(),
        })
        .run();

      if (fs.existsSync(/* turbopackIgnore: true */ run.worktreePath)) {
        const ralphDir = path.join(/* turbopackIgnore: true */ run.worktreePath, ".ralph");
        fs.mkdirSync(/* turbopackIgnore: true */ ralphDir, { recursive: true });
        fs.writeFileSync(
          path.join(/* turbopackIgnore: true */ ralphDir, "PROMPT.md"),
          promptMd,
        );
        fs.rmSync(path.join(/* turbopackIgnore: true */ ralphDir, "DONE"), { force: true });
        fs.rmSync(path.join(/* turbopackIgnore: true */ ralphDir, "DONE.md"), { force: true });
      }
      appendFeedbackTask(
        card.id,
        'Address the feedback in the "Reviewer feedback — address this first" section at the top of your prompt: fix every point it raises, then re-run the checks it names.',
      );
      if (!this.dependencies.moveCard(card.id, "reviewing", "ready", "rejected with feedback")) {
        throw new ClientError("review claim was lost before rejection completed");
      }
    } catch (error) {
      db.delete(plans).where(eq(plans.id, planId)).run();
      db.delete(reviews).where(eq(reviews.id, reviewId)).run();
      this.dependencies.moveCard(card.id, "reviewing", "review", "review operation failed");
      throw error;
    }

    emitEvent("plan.created", { cardId: card.id, payload: { version: plan.version + 1 } });
    emitEvent("review.decided", {
      cardId: card.id,
      runId,
      payload: { decision: "rejected" },
    });
    this.dependencies.pump();
  }

  async abandon(cardId: string): Promise<void> {
    const card = this.dependencies.getCard(cardId);
    if (!card) throw new ClientError("card not found");
    if (card.status === "abandoned") return;
    const safeStatuses: CardStatus[] = [
      "backlog",
      "todo",
      "ready",
      "paused",
      "review",
      "plan_review",
      "needs_attention",
    ];
    if (!safeStatuses.includes(card.status)) {
      throw new ClientError(`cannot abandon a card in status ${card.status}`);
    }
    const active = db
      .select()
      .from(runs)
      .where(and(eq(runs.cardId, cardId), eq(runs.status, "running")))
      .limit(1)
      .get();
    if (active) throw new ClientError("cannot abandon a card with an active run; cancel it first");
    const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get();
    if (!repo) throw new ClientError("repo not found");
    if (!this.dependencies.moveCard(cardId, card.status, "abandoned")) {
      throw new ClientError("card status changed while it was being abandoned");
    }
    const run = this.dependencies.latestWorktreeRun(cardId);
    if (run) await removeWorktree(repo.path, run.worktreePath, run.branch);
    fs.rmSync(/* turbopackIgnore: true */ planStatePath(cardId), { force: true });
  }

  private reviewForRun(runId: string) {
    return db.select().from(reviews).where(eq(reviews.runId, runId)).limit(1).get();
  }

  /** Evaluator runs must not make the loop they assess stale. */
  private latestLoopRun(cardId: string) {
    return db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.cardId, cardId),
          eq(runs.kind, "loop"),
        ),
      )
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get();
  }

  /** Claim the current completed loop before any Git/filesystem side effect. */
  private claimReviewRun(runId: string, expectedStatus: "review" | "needs_attention") {
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) throw new ClientError("run not found");
    if (run.kind !== "loop" || run.status !== "completed") {
      throw new ClientError("reviews require a completed loop run");
    }
    const card = this.dependencies.getCard(run.cardId);
    if (!card) throw new ClientError("card not found");
    if (card.status !== expectedStatus) {
      throw new ClientError(`cannot review a card in status ${card.status}`);
    }
    const latest = this.latestLoopRun(card.id);
    if (latest?.id !== run.id) throw new ClientError("run is stale; review the card's current run");
    const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get();
    if (!repo) throw new ClientError("repo not found");
    if (!this.dependencies.moveCard(card.id, expectedStatus, "reviewing")) {
      throw new ClientError("review decision is already in progress");
    }
    return { run, card: { ...card, status: "reviewing" as const }, repo };
  }

  private async approveClaimedRun(
    runId: string,
    expectedStatus: "review" | "needs_attention",
  ): Promise<{ ok: boolean; error?: string }> {
    const { run, card, repo } = this.claimReviewRun(runId, expectedStatus);

    // Spec 14: THE load-bearing integrity check — re-verify the parent repo's
    // hooks and config immediately before the trusted, unsandboxed merge,
    // however long the card sat in In Review. (Refs are excluded here: other
    // branches may have moved legitimately since the run-end check.)
    const baseline = loadBaseline(run.id);
    if (baseline) {
      let violations: string[];
      try {
        violations = await checkRepoIntegrity(repo.path, baseline, {
          runBranch: run.branch,
          checkRefs: false,
        });
      } catch (error) {
        this.dependencies.moveCard(card.id, "reviewing", expectedStatus, "review operation failed");
        throw error;
      }
      if (violations.length > 0) {
        const reason = `pre-merge repo integrity violation: ${violations.join("; ")}`;
        this.dependencies.moveCard(card.id, "reviewing", "needs_attention", reason);
        emitEvent("review.decided", {
          cardId: card.id,
          runId,
          payload: { decision: "approved", integrityViolation: reason },
        });
        return { ok: false, error: reason };
      }
    }

    let result: Awaited<ReturnType<typeof mergeBranch>>;
    try {
      result = await mergeBranch(
        repo.path,
        run.baseBranch ?? repo.defaultBranch,
        run.branch,
        `ralph: merge "${card.title}" (card ${card.id})`,
      );
    } catch (error) {
      this.dependencies.moveCard(card.id, "reviewing", expectedStatus, "review operation failed");
      throw error;
    }
    if (!result.ok) {
      if (result.conflict && (await this.reloopForConflict(card, run, repo, result.error!))) {
        emitEvent("review.decided", {
          cardId: card.id,
          runId,
          payload: { decision: "approved", mergeConflict: result.error, reloop: true },
        });
        return {
          ok: false,
          error: `merge conflict — handed back to the loop to resolve: ${result.error}`,
        };
      }
      this.dependencies.moveCard(card.id, "reviewing", "needs_attention", result.error);
      emitEvent("review.decided", {
        cardId: card.id,
        runId,
        payload: { decision: "approved", mergeFailed: result.error },
      });
      return { ok: false, error: result.error };
    }

    db.insert(reviews)
      .values({
        id: nanoid(),
        runId,
        decision: "approved",
        mergeCommit: result.mergeCommit,
        createdAt: now(),
      })
      .run();
    if (!this.dependencies.moveCard(card.id, "reviewing", "done")) {
      throw new ClientError("review claim was lost before completion");
    }
    removeBaseline(run.id);
    await removeWorktree(repo.path, run.worktreePath, run.branch);
    emitEvent("review.decided", {
      cardId: card.id,
      runId,
      payload: { decision: "approved", mergeCommit: result.mergeCommit },
    });
    return { ok: true };
  }

  /** Re-enter the loop with base-branch conflicts exposed in the worktree. */
  private async reloopForConflict(
    card: Card,
    run: Run,
    repo: Repo,
    error: string,
  ): Promise<boolean> {
    if (!fs.existsSync(/* turbopackIgnore: true */ run.worktreePath)) return false;
    const baseBranch = run.baseBranch ?? repo.defaultBranch;
    const merged = await mergeBaseIntoWorktree(run.worktreePath, baseBranch);
    if (!merged.ok && !merged.conflicted) return false;

    const plan = this.dependencies.latestPlan(card.id)!;
    const preamble = merged.conflicted
      ? `## Merge conflict — resolve this first\n\nYour branch conflicts with \`${baseBranch}\`, which changed while you worked. \`${baseBranch}\` has been merged into your branch and the conflicted files now contain \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` markers. Resolve every marker (keep both your work and the base's intent), remove the markers, and write the normal completion signals so the orchestrator can record the merge. Only once the working tree is clean, finish the task and write DONE as usual.`
      : `## Rebased onto \`${baseBranch}\`\n\nThe base branch moved on and has been merged into your branch cleanly. Re-check that your work still applies on top of it, then finish and write DONE as usual.`;
    const promptMd = `${preamble}\n\n---\n\n${plan.promptMd}`;
    db.insert(plans)
      .values({
        id: nanoid(),
        cardId: card.id,
        version: plan.version + 1,
        planMd: plan.planMd,
        promptMd,
        acceptanceCriteria: plan.acceptanceCriteria,
        feedback: `merge conflict with ${baseBranch}: ${error}`,
        createdAt: now(),
      })
      .run();
    emitEvent("plan.created", { cardId: card.id, payload: { version: plan.version + 1 } });
    const mergeTask = merged.conflicted
      ? "Follow the base-branch merge section at the top of your prompt: resolve every conflict marker while keeping both intents, then run `git diff --check` as this task's targeted verification."
      : "Follow the base-branch merge section at the top of your prompt: confirm the implementation still applies after the clean base-branch merge, then run `git diff --check` as this task's targeted verification.";
    appendFeedbackTask(card.id, mergeTask);
    this.dependencies.moveCard(card.id, card.status, "ready", "merge conflict — resolving in loop");
    this.dependencies.pump();
    return true;
  }
}
