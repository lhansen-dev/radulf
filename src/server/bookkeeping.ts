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
 *   0. Plan state        (planStatePath, readPlanState)
 *   1. Prompt helpers    (taskInjectionBlock, buildLoopPrompt)
 *   2. Message helpers   (deterministicCommitMessage)
 *   3. Signal I/O        (ralphDirPath, readFileIfExists, removeRalphFiles,
 *                         iterationDonePath, readIterationDone, doneFilePath)
 *   4. Progress helpers  (buildProgressState)
 *   5. Iteration flow    (performIterationBookkeeping)
 *   6. Done flow         (performDoneBookkeeping)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/db";
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
  return path.join(DATA_DIR, "plans", `${cardId}.md`);
}

/** The card's private PLAN.md, or null when none is on disk. */
export function readPlanState(cardId: string): string | null {
  return readFileIfExists(planStatePath(cardId)) || null;
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
    "If the task cannot be done for a reason outside your control — credentials,",
    "network access, or a logged-in session you do not have, a decision only the",
    "operator can make, a prerequisite that does not exist — do NOT write",
    "`.ralph/ITERATION_DONE`. Write the concrete blocker and what the operator",
    "must supply into `.ralph/BLOCKED` and stop. Never invent evidence or mark",
    "the task complete.",
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

/** The worktree's `.ralph/` directory, where every signal file lives. */
export function ralphDirPath(worktreePath: string): string {
  return path.join(/* turbopackIgnore: true */ worktreePath, ".ralph");
}

/** The file's contents, or `""` when it does not exist. */
export function readFileIfExists(filePath: string): string {
  return fs.existsSync(/* turbopackIgnore: true */ filePath)
    ? fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8")
    : "";
}

/** Remove the named `.ralph/` files; missing ones are not an error. */
export function removeRalphFiles(worktreePath: string, names: readonly string[]): void {
  const dir = ralphDirPath(worktreePath);
  for (const name of names) {
    fs.rmSync(path.join(/* turbopackIgnore: true */ dir, name), { force: true });
  }
}

/** Small models write DONE.md as often as DONE — accept both. */
export const DONE_FILE_NAMES = ["DONE", "DONE.md"] as const;

/** The DONE signal file present in `ralphDir`, or null when there is none. */
export function doneFilePath(ralphDir: string): string | null {
  for (const name of DONE_FILE_NAMES) {
    const p = path.join(/* turbopackIgnore: true */ ralphDir, name);
    if (fs.existsSync(/* turbopackIgnore: true */ p)) return p;
  }
  return null;
}

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
 * any `git status --porcelain` output (non-empty = worktree is dirty) plus a
 * hash of the dirty content, and the current private-plan checklist.  Dirty
 * state counts as progress so an uncommitted useful edit is not mislabeled as
 * "no activity" — and the content hash matters because porcelain lists only
 * paths: once a file is modified, further edits to it leave the status
 * output byte-identical.
 */
export async function buildProgressState(
  worktreePath: string,
  planPath: string,
): Promise<string> {
  const head = (await tryGit(worktreePath, "rev-parse", "HEAD")).out;
  const checklist = readFileIfExists(planPath);
  const status = (await tryGit(worktreePath, "status", "--porcelain")).out;
  const dirty = status ? `${status}\n${await dirtyContentHash(worktreePath)}` : "";
  return `${head}\n${dirty}\n${checklist}`;
}

/**
 * Hash of every uncommitted change: the tracked diff against HEAD (staged and
 * unstaged alike) plus the path and bytes of each untracked, non-ignored file.
 */
async function dirtyContentHash(worktreePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(
    (await tryGit(worktreePath, "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD")).out,
  );
  const untracked = (await tryGit(worktreePath, "ls-files", "--others", "--exclude-standard", "-z")).out;
  for (const rel of untracked.split("\0").filter(Boolean)) {
    const abs = path.join(/* turbopackIgnore: true */ worktreePath, rel);
    hash.update(`\0${rel}\0`);
    try {
      const stat = fs.lstatSync(/* turbopackIgnore: true */ abs);
      hash.update(
        stat.isSymbolicLink()
          ? fs.readlinkSync(/* turbopackIgnore: true */ abs)
          : fs.readFileSync(/* turbopackIgnore: true */ abs),
      );
    } catch {
      // Removed between the listing and the read — the path alone still counts.
    }
  }
  return hash.digest("hex");
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
 * Whether there is work to credit for this iteration's `ITERATION_DONE`:
 * a new HEAD (the agent committed), or any uncommitted change other than
 * `.ralph/ITERATION_DONE` — whether it appeared during this iteration or was
 * already sitting in the worktree when it started. Guards against phantom
 * completions — tasks marked done whose edits were never applied.
 *
 * Pre-existing changes count because every other writer to a loop worktree
 * (planner, evaluator, this bookkeeping) commits its own output, so anything
 * uncommitted is loop-agent work not yet accounted for — typically edits from
 * an iteration that failed or timed out before signalling, or from an earlier
 * run of the same card. The checklist only advances on a commit, so that work
 * always belongs to the task still unchecked. Comparing only this iteration's
 * delta instead used to wedge the loop: an agent that found the task already
 * done had nothing left to change, so every completion was a phantom until the
 * run stalled, and every retry reused the same dirty worktree.
 */
export async function hasIterationWorkProduct(
  worktreePath: string,
  pre: PreIterationState,
): Promise<boolean> {
  const current = await captureIterationState(worktreePath);
  return (
    current.head !== pre.head ||
    statusWithoutSignal(pre.status) !== "" ||
    statusWithoutSignal(current.status) !== ""
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
 * When `opts.pre` is provided and there is no work product (no new HEAD and
 * no uncommitted change beyond the signal file — see
 * `hasIterationWorkProduct`), the completion is
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

  const donePath = doneFilePath(ralphDir);
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
