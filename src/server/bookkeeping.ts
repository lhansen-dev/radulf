/**
 * bookkeeping.ts — orchestrator bookkeeping helpers.
 *
 * The loop agent never handles PLAN.md checklist marking or git commits —
 * it cannot even read PLAN.md, which lives outside the worktree. The agent
 * does its injected task and writes a short summary to
 * `.ralph/ITERATION_DONE`; the orchestrator performs all mechanical
 * bookkeeping (checklist tick, commit, signal-file cleanup) via the
 * functions in this module.
 *
 * Module layout:
 *
 *   0. Plan state        (planStatePath)
 *   1. Prompt helpers    (taskInjectionBlock, buildLoopPrompt)
 *   2. Message helpers   (deterministicCommitMessage)
 *   3. Signal I/O        (iterationDonePath, readIterationDone)
 *   4. Progress helpers  (buildProgressState)
 *   5. Iteration flow    (performIterationBookkeeping)
 *   6. Done flow         (performDoneBookkeeping)
 */

import fs from "node:fs";
import path from "node:path";
import { firstUnchecked, markChecked } from "./checklist";
import { tryGit } from "./git";

// ---------------------------------------------------------------------------
// 0. Plan state
// ---------------------------------------------------------------------------

/**
 * The orchestrator-private PLAN.md for a card.
 *
 * The live checklist lives OUTSIDE every worktree so the loop agent can never
 * read it — the agent only ever sees the single task injected into its
 * prompt. The orchestrator alone reads and ticks this file.
 */
export function planStatePath(cardId: string): string {
  if (process.env.RADULF_DATA_DIR) {
    return path.join(
      /* turbopackIgnore: true */ process.env.RADULF_DATA_DIR,
      "plans",
      `${cardId}.md`,
    );
  }
  return path.join(process.cwd(), "data", "plans", `${cardId}.md`);
}

// ---------------------------------------------------------------------------
// 1. Prompt helpers
// ---------------------------------------------------------------------------

/**
 * Build a task-injection block from a PLAN.md string.
 *
 * Calls `firstUnchecked(planMd)` and returns a block containing the task
 * number, the exact selected item text (multiline preserved), a
 * `LAST_TASK=true|false` line, and guidance.  This block is the agent's ONLY
 * task source — PLAN.md is orchestrator-private and never enters the
 * worktree, so there is nothing else to consult.  Returns `""` when
 * `firstUnchecked` returns `null` or `planMd` is empty/missing — never
 * throws.
 */
export function taskInjectionBlock(planMd: string): string {
  if (!planMd) return "";
  const task = firstUnchecked(planMd);
  if (task === null) return "";

  const lastTaskFlag = task.isLastUnchecked ? "LAST_TASK=true" : "LAST_TASK=false";

  return [
    "## Your assigned task",
    "",
    `Task #${task.taskNumber}:`,
    task.item.text,
    "",
    lastTaskFlag,
    "",
    "This is your ONLY task this iteration. It was selected for you — there is",
    "no task list to consult and no checklist to update; do not look for one.",
    "The orchestrator tracks completion. Run only the targeted check named in",
    "your assigned task.",
    "",
    "---",
  ].join("\n");
}

/**
 * Build the prompt fed to the loop agent: the injected task block followed by
 * the plan's PROMPT.md.
 *
 * There is no fallback: the checklist is validated at plan time and the
 * orchestrator checks for an unchecked task before every iteration, so a
 * plan that yields no task here is a caller bug — this throws.
 */
export function buildLoopPrompt(promptMd: string, planMd: string): string {
  const block = taskInjectionBlock(planMd);
  if (!block) {
    throw new Error(
      "buildLoopPrompt: plan checklist has no unchecked task — the orchestrator must not start an iteration without one",
    );
  }
  return `${block}\n\n${promptMd}`;
}

// ---------------------------------------------------------------------------
// 2. Message helpers
// ---------------------------------------------------------------------------

/**
 * Return a deterministic commit message for a completed task.
 *
 * Format: `ralph: task {n} — {summary}`
 */
export function deterministicCommitMessage(taskNumber: number, summary: string): string {
  return `ralph: task ${taskNumber} — ${summary}`;
}

// ---------------------------------------------------------------------------
// 3. Signal I/O
// ---------------------------------------------------------------------------

/** Return the path to `.ralph/ITERATION_DONE` within `ralphDir`. */
export function iterationDonePath(ralphDir: string): string {
  return path.join(/* turbopackIgnore: true */ ralphDir, "ITERATION_DONE");
}

/**
 * Read the ITERATION_DONE signal file.
 *
 * Returns the trimmed file contents, or `null` when the file is missing or
 * empty (after trimming).
 */
export function readIterationDone(ralphDir: string): string | null {
  const p = iterationDonePath(ralphDir);
  try {
    const content = fs.readFileSync(/* turbopackIgnore: true */ p, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Progress helpers
// ---------------------------------------------------------------------------

/**
 * Build a progress-state string for stall detection: the `HEAD` commit hash,
 * any `git status --porcelain` output (non-empty = worktree is dirty), and
 * the current private-plan checklist.  Dirty state counts as progress so an
 * uncommitted useful edit is not mislabeled as "no activity".
 */
export async function buildProgressState(
  worktreePath: string,
  planPath: string,
): Promise<string> {
  const head = (await tryGit(worktreePath, "rev-parse", "HEAD")).out;
  const checklist = fs.existsSync(/* turbopackIgnore: true */ planPath)
    ? fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8")
    : "";
  const dirty = (await tryGit(worktreePath, "status", "--porcelain")).out;
  return `${head}\n${dirty}\n${checklist}`;
}

/** Snapshot of the worktree taken just before a loop iteration runs. */
export type PreIterationState = {
  head: string;
  status: string;
};

/** Capture HEAD and `git status --porcelain` for phantom-completion checks. */
export async function captureIterationState(
  worktreePath: string,
): Promise<PreIterationState> {
  return {
    head: (await tryGit(worktreePath, "rev-parse", "HEAD")).out,
    status: (await tryGit(worktreePath, "status", "--porcelain")).out,
  };
}

/** The ITERATION_DONE signal itself must not count as a work product. */
function statusWithoutSignal(status: string): string {
  return status
    .split("\n")
    .filter((line) => line.trim() && !line.includes("ITERATION_DONE"))
    .join("\n");
}

/**
 * Whether the iteration changed anything beyond writing the signal file:
 * a new HEAD (the agent committed) or any status delta other than
 * `.ralph/ITERATION_DONE`. Guards against phantom completions — tasks
 * marked done whose edits were never applied.
 */
export async function hasIterationWorkProduct(
  worktreePath: string,
  pre: PreIterationState,
): Promise<boolean> {
  const current = await captureIterationState(worktreePath);
  return (
    current.head !== pre.head ||
    statusWithoutSignal(current.status) !== statusWithoutSignal(pre.status)
  );
}

// ---------------------------------------------------------------------------
// 5. Iteration flow
// ---------------------------------------------------------------------------

/**
 * Perform bookkeeping for one completed iteration.
 *
 * When `.ralph/ITERATION_DONE` exists inside `ralphDir`:
 *   - read the summary from the signal file
 *   - find the first unchecked item in the private plan at `opts.planPath`
 *   - mark it checked and write the plan back (the plan lives outside the
 *     worktree, so the commit below never includes it)
 *   - remove the signal file
 *   - `git add -A && git commit` with a deterministic message
 *   - return `{ advanced: true, isLast, taskNumber, summary }`
 *
 * When `opts.pre` is provided and the iteration produced no work product
 * (no new HEAD, no status delta beyond the signal file), the completion is
 * a phantom: the signal is removed, the checklist is NOT advanced, and
 * `{ advanced: false, phantom: true, ... }` is returned so the caller can
 * surface it — the unchanged worktree then feeds normal stall detection.
 *
 * Returns `null` when no signal file exists (missing-signal path).
 */
export async function performIterationBookkeeping(opts: {
  ralphDir: string;
  worktreePath: string;
  planPath: string;
  pre?: PreIterationState;
}): Promise<
  | { advanced: true; isLast: boolean; taskNumber: number; summary: string }
  | { advanced: false; phantom: true; taskNumber: number; summary: string }
  | null
> {
  const { ralphDir, worktreePath, planPath } = opts;
  const summary = readIterationDone(ralphDir);
  if (summary === null) {
    return null;
  }

  const planMd = fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8");
  const task = firstUnchecked(planMd);
  if (task === null) {
    // No unchecked item — this is unexpected but not fatal.  Remove the
    // signal file and return null so the caller falls through to stall
    // detection / DONE check.
    fs.rmSync(/* turbopackIgnore: true */ iterationDonePath(ralphDir), { force: true });
    return null;
  }

  if (opts.pre && !(await hasIterationWorkProduct(worktreePath, opts.pre))) {
    fs.rmSync(/* turbopackIgnore: true */ iterationDonePath(ralphDir), { force: true });
    return {
      advanced: false,
      phantom: true,
      taskNumber: task.taskNumber,
      summary,
    };
  }

  const updated = markChecked(planMd, task.taskNumber);
  fs.writeFileSync(/* turbopackIgnore: true */ planPath, updated);

  // Remove the signal file.
  fs.rmSync(/* turbopackIgnore: true */ iterationDonePath(ralphDir), { force: true });

  // Stage everything and commit.
  await tryGit(worktreePath, "add", "-A");
  await tryGit(
    worktreePath,
    "commit",
    "-m",
    deterministicCommitMessage(task.taskNumber, summary),
  );

  return {
    advanced: true,
    isLast: task.isLastUnchecked,
    taskNumber: task.taskNumber,
    summary,
  };
}

// ---------------------------------------------------------------------------
// 6. Done flow
// ---------------------------------------------------------------------------

/**
 * Perform bookkeeping for the final (DONE) item.
 *
 * When `.ralph/DONE` or `.ralph/DONE.md` exists:
 *   - read the first line as the summary (TLDR)
 *   - find and mark the first unchecked item in the private plan at
 *     `opts.planPath` (if any)
 *   - commit with `deterministicCommitMessage`
 *   - return `{ taskNumber, summary }`
 *
 * Returns `null` when no DONE file exists.
 */
export async function performDoneBookkeeping(opts: {
  ralphDir: string;
  worktreePath: string;
  planPath: string;
}): Promise<{ taskNumber: number; summary: string } | null> {
  const { ralphDir, worktreePath, planPath } = opts;

  // Find DONE or DONE.md
  let donePath: string | null = null;
  for (const name of ["DONE", "DONE.md"]) {
    const p = path.join(/* turbopackIgnore: true */ ralphDir, name);
    if (fs.existsSync(/* turbopackIgnore: true */ p)) {
      donePath = p;
      break;
    }
  }

  if (donePath === null) {
    return null;
  }

  const content = fs.readFileSync(/* turbopackIgnore: true */ donePath, "utf8").trim();
  // First line is the TLDR summary.
  const firstNewline = content.indexOf("\n");
  const summary = firstNewline === -1 ? content : content.slice(0, firstNewline);

  const planMd = fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8");
  const task = firstUnchecked(planMd);

  if (task !== null) {
    const updated = markChecked(planMd, task.taskNumber);
    fs.writeFileSync(/* turbopackIgnore: true */ planPath, updated);

    // Stage and commit.
    await tryGit(worktreePath, "add", "-A");
    await tryGit(
      worktreePath,
      "commit",
      "-m",
      deterministicCommitMessage(task.taskNumber, summary),
    );
  }

  return {
    taskNumber: task?.taskNumber ?? 0,
    summary,
  };
}
