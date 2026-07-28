import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { WORKTREES_DIR, TRANSCRIPTS_DIR } from "@/db";
import { git, tryGit } from "./git";
import { runHarness } from "./harness";
import type { ProviderId } from "./providers";
import type { Settings } from "./settings";
import { readPmPrompt, parseProposals, type Proposal } from "./pm";

/**
 * Render the improve-run prompt template: `{{EXISTING_CARDS}}` becomes the
 * bullet list of titles already proposed this run (via `readPmPrompt`), and
 * `{{FOCUS}}` becomes the run's optional focus prompt, or a neutral
 * placeholder telling the planner to use its own judgment.
 */
export function renderImprovePrompt(
  priorTitles: string[],
  template: string,
  focusPrompt?: string | null
): string {
  const withCards = readPmPrompt(priorTitles, template);
  const focus = focusPrompt?.trim()
    ? focusPrompt.trim()
    : "(none — use your own judgment about what is most valuable to improve next.)";
  return withCards.replaceAll("{{FOCUS}}", focus);
}

export type ProposeOneImprovementInput = {
  repo: { path: string };
  /** Feature branch accumulating this run's approved changes; the proposer
   * views its tip, not the user's checked-out branch. */
  featureBranch: string;
  focusPrompt?: string | null;
  /** Titles of improvements already created this run (N1 — dedup/no-repeat). */
  priorTitles: string[];
  plannerProvider: ProviderId;
  plannerModel: string;
  plannerReasoningLevel: string;
  s: Settings;
};

/**
 * Propose the single next improvement for an Improvement Run. Spawns a
 * read-only planner pass against an ephemeral detached worktree checked out
 * at the feature branch's tip (N1), so the proposer sees every change already
 * accumulated this run without disturbing the user's own checkout. Returns
 * `null` when the planner errors, times out, or proposes nothing usable.
 */
export async function proposeOneImprovement(
  input: ProposeOneImprovementInput
): Promise<Proposal | null> {
  const { repo, featureBranch, focusPrompt, priorTitles, plannerProvider, plannerModel, plannerReasoningLevel, s } =
    input;

  const prompt = renderImprovePrompt(priorTitles, s.improvePromptTemplate, focusPrompt);

  const worktreePath = path.join(WORKTREES_DIR, `improve-proposer-${nanoid()}`);
  await git(repo.path, "worktree", "add", "--detach", worktreePath, featureBranch);
  try {
    const result = await runHarness({
      provider: plannerProvider,
      model: plannerModel,
      reasoningLevel: plannerReasoningLevel,
      prompt,
      cwd: worktreePath,
      transcriptPath: path.join(TRANSCRIPTS_DIR, `improve-${nanoid()}.jsonl`),
      // A read-only review of a real repo (ls → grep → read a dozen files →
      // git log) is slow: an observed live pass on this repo took 522s to
      // settle. 5 minutes discarded finished work; 15 leaves headroom while
      // still bounding a wedged pass well inside a typical run budget.
      timeoutMs: 900_000,
      readOnly: true,
    });

    if (result.timedOut || result.error || result.code !== 0) return null;

    const proposals = parseProposals(result.lastText);
    return proposals[0] ?? null;
  } finally {
    await tryGit(repo.path, "worktree", "remove", "--force", worktreePath);
    await tryGit(repo.path, "worktree", "prune");
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
}
