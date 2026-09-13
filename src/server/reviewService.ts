import fs from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  db,
  now,
  cards,
  improvementRuns,
  plans,
  runs,
  reviews,
  repos,
  type CardStatus,
} from "@/db";
import { emitEvent } from "./events";
import {
  hasRemote,
  mergeBaseIntoWorktree,
  mergeBranch,
  pushBranch,
  removeWorktree,
  stripRalphForDelivery,
} from "./git";
import { createPullRequest, githubStatus, invalidateGithubStatus } from "./github";
import { getSettings } from "./settings";
import { planStatePath } from "./bookkeeping";
import { appendTask } from "./checklist";
import { ClientError } from "./clientError";
import { checkRepoIntegrity, loadBaseline, removeBaseline } from "./integrity";

/** Every iteration runs on an injected checklist task, so a merge-conflict
 * re-entry must append one to the private plan — a prompt preamble alone
 * never runs. */
function appendFeedbackTask(cardId: string, text: string): string | null {
  const planPath = planStatePath(cardId);
  if (!fs.existsSync(/* turbopackIgnore: true */ planPath)) return null;
  const updated = appendTask(fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8"), text);
  fs.writeFileSync(/* turbopackIgnore: true */ planPath, updated);
  return updated;
}

/** Who released this particular diff. Spec 15 uses it to decide draft-ness of
 * a delivered pull request; it describes the approval, not the card. */
export type ApprovedBy = "human" | "auto";

type Card = typeof cards.$inferSelect;
type Plan = typeof plans.$inferSelect;
type Run = typeof runs.$inferSelect;
type Repo = typeof repos.$inferSelect;

/**
 * Is this card one an Improvement Run spawned onto its feature branch?
 *
 * Improvement Runs accumulate by design: every card they create takes the run's
 * `ralph/improve-*` branch as its base, "so approve-merges fold back into it
 * with no new merge code" (`schema.ts`). PR delivery would break that outright —
 * the feature branch is local-only, so there is nothing on `origin` to open a
 * pull request against, and even if there were, the run's whole accumulation
 * model is the local merge. So the workspace-wide `openPr` never reaches these
 * cards. It is a setting about how *your* approved work is delivered, and an
 * Improvement Run's internal steps are not that.
 */
function belongsToImprovementRun(repoId: string, baseBranch: string | null): boolean {
  if (!baseBranch) return false;
  return Boolean(
    db
      .select({ id: improvementRuns.id })
      .from(improvementRuns)
      .where(
        and(
          eq(improvementRuns.repoId, repoId),
          eq(improvementRuns.featureBranch, baseBranch),
        ),
      )
      .get(),
  );
}

/** The PR description. Everything in it is content Radulf already holds — the
 * card's own description and the summary the evaluator wrote on approve — so a
 * reviewer arriving cold gets the intent, not just a diff. */
function pullRequestBody(card: Card, draft: boolean): string {
  const parts = [card.description.trim()];
  if (card.summary?.trim()) parts.push(`## Summary\n\n${card.summary.trim()}`);
  parts.push(
    draft
      ? `---\n\nOpened by Radulf from card \`${card.id}\`. **Draft:** approved by Radulf's evaluator, not by a human.`
      : `---\n\nOpened by Radulf from card \`${card.id}\`, after human review of the diff.`,
  );
  return parts.filter(Boolean).join("\n\n");
}

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

  /**
   * `approvedBy` is not bookkeeping: spec 15 uses it to decide whether a
   * delivered pull request is a draft. It describes THIS approval, not the
   * card's flags — a card whose `autoApprove` is set can still be approved by
   * a human later (via `retryMerge`), and that one is not a draft.
   */
  async approve(
    runId: string,
    approvedBy: ApprovedBy = "human",
  ): Promise<{ ok: boolean; error?: string }> {
    const existing = this.reviewForRun(runId);
    if (existing) {
      if (existing.decision === "approved") return { ok: true };
      throw new ClientError("run was already rejected");
    }
    return this.approveClaimedRun(runId, "review", approvedBy);
  }

  /**
   * Retry only the delivery for a completed loop whose first attempt failed —
   * a merge, or since spec 15 a push + pull request. The name predates the
   * second delivery target; the path is the same one either way, which is why
   * a failed push needs no separate retry of its own.
   */
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
    // Always "human": retry is an operator clicking a button on a card that
    // has already failed once.
    return this.approveClaimedRun(run.id, "needs_attention", "human");
  }

  /**
   * A rejected diff goes back to the planner, not straight to the loop: the
   * planner re-plans on top of the branch with the feedback in its prompt
   * (see `pendingRejectionFeedback`). The card waits in Todo as a manual
   * start, so `pump` plans it as soon as the repo's pipeline slot is free.
   */
  reject(runId: string, feedback: string) {
    if (!feedback.trim()) throw new ClientError("feedback is required to reject");
    const existing = this.reviewForRun(runId);
    if (existing) {
      if (existing.decision === "rejected") return;
      throw new ClientError("run was already approved");
    }
    const { card } = this.claimReviewRun(runId, "review");
    if (!this.dependencies.latestPlan(card.id)) {
      this.dependencies.moveCard(card.id, "reviewing", "review", "review operation failed");
      throw new ClientError("card has no plan");
    }

    const reviewId = nanoid();
    try {
      db.insert(reviews)
        .values({ id: reviewId, runId, decision: "rejected", feedback, createdAt: now() })
        .run();
      if (!this.dependencies.moveCard(card.id, "reviewing", "todo", "rejected with feedback — re-planning")) {
        throw new ClientError("review claim was lost before rejection completed");
      }
    } catch (error) {
      db.delete(reviews).where(eq(reviews.id, reviewId)).run();
      this.dependencies.moveCard(card.id, "reviewing", "review", "review operation failed");
      throw error;
    }

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
    approvedBy: ApprovedBy,
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

    // Spec 15: an approved diff is delivered either into the local base branch
    // or as a pull request — never both, which would leave two descriptions of
    // one change with the PR stale from the first push of the base.
    if (
      (card.openPr || getSettings().openPr) &&
      !belongsToImprovementRun(card.repoId, run.baseBranch)
    ) {
      return this.deliverPullRequest(card, run, repo, expectedStatus, approvedBy);
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

  /**
   * Spec 15: deliver the approved diff as a GitHub pull request instead of
   * merging it into the local base branch.
   *
   * Runs host-side and unsandboxed from the same place `mergeBranch` runs,
   * downstream of the same claim and the same pre-merge integrity check. No
   * agent can reach any of it — see the note on `github.ts`.
   *
   * The order below is deliberate:
   *
   *   preconditions → merge base in → strip `.ralph` → push → open PR
   *
   * Preconditions first so a missing `gh` costs nothing and leaves the card
   * exactly where it was. Base merged in *before* the push, because skipping it
   * would only relocate the conflict to GitHub, where the operator finds it
   * later and without the hand-back-to-the-loop recovery that already exists.
   * `.ralph` stripped *after* that merge, so a hand-back never sees a worktree
   * whose loop memory has been removed — and stripped at all because every
   * review surface excludes `.ralph`, so publishing it would push to a remote
   * precisely the content a human was not shown.
   */
  private async deliverPullRequest(
    card: Card,
    run: Run,
    repo: Repo,
    expectedStatus: "review" | "needs_attention",
    approvedBy: ApprovedBy,
  ): Promise<{ ok: boolean; error?: string }> {
    const baseBranch = run.baseBranch ?? repo.defaultBranch;

    /** A precondition the operator fixes outside Radulf and then retries.
     * The card goes back where it was rather than to needs_attention, so the
     * Approve button they just used is still there. */
    const unmet = (reason: string) => {
      this.dependencies.moveCard(card.id, "reviewing", expectedStatus, reason);
      emitEvent("review.decided", {
        cardId: card.id,
        runId: run.id,
        payload: { decision: "approved", delivery: "pr", prBlocked: reason },
      });
      return { ok: false, error: reason };
    };
    /** Delivery itself failed. Same destination a failed merge gets, and
     * explicitly NOT a fallback to merging — the operator asked for a pull
     * request, and quietly merging instead is the worst outcome available. */
    const failed = (reason: string) => {
      invalidateGithubStatus();
      this.dependencies.moveCard(card.id, "reviewing", "needs_attention", reason);
      emitEvent("review.decided", {
        cardId: card.id,
        runId: run.id,
        payload: { decision: "approved", delivery: "pr", prFailed: reason },
      });
      return { ok: false, error: reason };
    };

    invalidateGithubStatus();
    const gh = await githubStatus();
    if (!gh.ok) return unmet(gh.detail);
    if (!(await hasRemote(repo.path))) {
      return unmet(`${repo.name} has no \`origin\` remote to open a pull request against`);
    }

    const merged = await mergeBaseIntoWorktree(run.worktreePath, baseBranch);
    if (merged.conflicted) {
      const error = `merge conflict with ${baseBranch}: ${merged.out}`;
      if (await this.reloopForConflict(card, run, repo, error, merged)) {
        emitEvent("review.decided", {
          cardId: card.id,
          runId: run.id,
          payload: { decision: "approved", delivery: "pr", mergeConflict: error, reloop: true },
        });
        return {
          ok: false,
          error: `merge conflict — handed back to the loop to resolve: ${merged.out}`,
        };
      }
      return failed(error);
    }
    if (!merged.ok) return failed(`cannot merge ${baseBranch} into the branch: ${merged.out}`);

    const stripped = await stripRalphForDelivery(
      run.worktreePath,
      `ralph: drop .ralph before delivery (card ${card.id})`,
    );
    if (!stripped.ok) return failed(`cannot drop .ralph before pushing: ${stripped.out}`);

    const pushed = await pushBranch(run.worktreePath, run.branch);
    if (!pushed.ok) return failed(`git push failed: ${pushed.error}`);

    // Draft turns on who released THIS diff, not on the card's flags, so that
    // "a non-draft PR from Radulf was seen by a human" holds by construction.
    const draft = approvedBy === "auto";
    const pr = await createPullRequest({
      worktreePath: run.worktreePath,
      baseBranch,
      branch: run.branch,
      title: card.title,
      body: pullRequestBody(card, draft),
      draft,
    });
    if (!pr.ok) return failed(`gh pr create failed: ${pr.error}`);

    db.insert(reviews)
      .values({ id: nanoid(), runId: run.id, decision: "approved", createdAt: now() })
      .run();
    if (!this.dependencies.moveCard(card.id, "reviewing", "done")) {
      throw new ClientError("review claim was lost before completion");
    }
    removeBaseline(run.id);
    // The remote holds the branch now, so the local worktree and branch are
    // reclaimed exactly as they are after a merge (spec 15 open question 2).
    await removeWorktree(repo.path, run.worktreePath, run.branch);
    emitEvent("review.decided", {
      cardId: card.id,
      runId: run.id,
      payload: {
        decision: "approved",
        delivery: "pr",
        grantedBy: card.openPr ? "card" : "global",
        draft,
        ...(pr.url ? { prUrl: pr.url } : {}),
      },
    });
    return { ok: true };
  }

  /**
   * Re-enter the loop with base-branch conflicts exposed in the worktree.
   *
   * `alreadyMerged` is for callers that had to merge base in themselves to
   * discover the conflict (spec 15's PR path merges proactively, since there
   * is no later merge to surface it). Re-running the merge on a worktree that
   * already holds conflict markers fails with "you have unmerged files", so
   * the result is passed in rather than recomputed.
   */
  private async reloopForConflict(
    card: Card,
    run: Run,
    repo: Repo,
    error: string,
    alreadyMerged?: Awaited<ReturnType<typeof mergeBaseIntoWorktree>>,
  ): Promise<boolean> {
    if (!fs.existsSync(/* turbopackIgnore: true */ run.worktreePath)) return false;
    const baseBranch = run.baseBranch ?? repo.defaultBranch;
    const merged =
      alreadyMerged ?? (await mergeBaseIntoWorktree(run.worktreePath, baseBranch));
    if (!merged.ok && !merged.conflicted) return false;

    const plan = this.dependencies.latestPlan(card.id)!;
    const preamble = merged.conflicted
      ? `## Merge conflict — resolve this first\n\nYour branch conflicts with \`${baseBranch}\`, which changed while you worked. \`${baseBranch}\` has been merged into your branch and the conflicted files now contain \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` markers. Resolve every marker (keep both your work and the base's intent), remove the markers, and write the normal completion signals so the orchestrator can record the merge. Only once the working tree is clean, finish the task and write DONE as usual.`
      : `## Rebased onto \`${baseBranch}\`\n\nThe base branch moved on and has been merged into your branch cleanly. Re-check that your work still applies on top of it, then finish and write DONE as usual.`;
    const promptMd = `${preamble}\n\n---\n\n${plan.promptMd}`;
    const mergeTask = merged.conflicted
      ? "Follow the base-branch merge section at the top of your prompt: resolve every conflict marker while keeping both intents, then run `git diff --check` as this task's targeted verification."
      : "Follow the base-branch merge section at the top of your prompt: confirm the implementation still applies after the clean base-branch merge, then run `git diff --check` as this task's targeted verification.";
    const planState = appendFeedbackTask(card.id, mergeTask);
    db.insert(plans)
      .values({
        id: nanoid(),
        cardId: card.id,
        version: plan.version + 1,
        // The checklist this re-entry runs, so the version history shows it.
        planMd: planState ?? plan.planMd,
        promptMd,
        acceptanceCriteria: plan.acceptanceCriteria,
        feedback: `merge conflict with ${baseBranch}: ${error}`,
        createdAt: now(),
      })
      .run();
    emitEvent("plan.created", { cardId: card.id, payload: { version: plan.version + 1 } });
    this.dependencies.moveCard(card.id, card.status, "ready", "merge conflict — resolving in loop");
    this.dependencies.pump();
    return true;
  }
}
