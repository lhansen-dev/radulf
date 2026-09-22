import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { WORKTREES_DIR, TRANSCRIPTS_DIR } from "@/db";
import { git, tryGit } from "./git";
import { runHarness } from "./harness";
import type { ProviderId } from "./providers";

export type Proposal = { title: string; description: string; rationale: string };

/**
 * Render the improve-run prompt template: `{{EXISTING_CARDS}}` becomes the
 * bullet list of titles already proposed this run (`- (none)` when empty),
 * and `{{FOCUS}}` becomes the run's optional focus prompt, or a neutral
 * placeholder telling the planner to use its own judgment.
 */
export function renderImprovePrompt(
  priorTitles: string[],
  template: string,
  focusPrompt?: string | null
): string {
  const cards = priorTitles.length > 0 ? priorTitles.map((t) => `- ${t}`).join("\n") : "- (none)";
  const focus = focusPrompt?.trim()
    ? focusPrompt.trim()
    : "(none — use your own judgment about what is most valuable to improve next.)";
  return template.replaceAll("{{EXISTING_CARDS}}", cards).replaceAll("{{FOCUS}}", focus);
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
  /** The improve prompt template (the `improvePromptTemplate` setting). */
  template: string;
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
  const { repo, featureBranch, focusPrompt, priorTitles, plannerProvider, plannerModel, plannerReasoningLevel, template } =
    input;

  const prompt = renderImprovePrompt(priorTitles, template, focusPrompt);

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

/**
 * Every plausible "the JSON array is in here" slice of a planner reply, best
 * candidate first. Models routinely ignore "output only JSON": two observed
 * live Improvement Run passes wrapped the array in a sentence of preamble,
 * and one wrote ```` ```json ```` *inside* a description string — which closes
 * a lazy fence match early. So we never trust a single extraction: callers try
 * these in order until one actually parses.
 *
 * 1. Fenced blocks whose body looks like an array (the documented shape).
 * 2. The outermost `[ … ]` span, which survives stray fences in prose.
 */
function jsonArrayCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:[a-zA-Z]*)?\n?([\s\S]*?)```/g)) {
    const body = match[1].trim();
    if (body.startsWith("[")) candidates.push(body);
  }
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  return candidates;
}

/**
 * Parse a planner model's JSON reply into an array of proposals.
 * Tolerates prose and markdown fences around the array (see
 * `jsonArrayCandidates`), then returns only elements that are objects with a
 * non-empty string `title` and non-empty string `description`. Missing
 * `rationale` is coerced to `""`. Capped to 3 items. Anything unparseable
 * returns `[]` (never throws).
 */
export function parseProposals(text: string): Proposal[] {
  let parsed: unknown;
  for (const candidate of jsonArrayCandidates(text)) {
    try {
      const attempt: unknown = JSON.parse(candidate);
      if (Array.isArray(attempt)) {
        parsed = attempt;
        break;
      }
    } catch {
      // Try the next candidate — a fence closed early by ``` inside a string
      // still leaves the outermost bracket span to fall back on.
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .slice(0, 3)
    .filter(
      (item: unknown): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).title === "string" &&
        (item as Record<string, unknown>).title !== "" &&
        typeof (item as Record<string, unknown>).description === "string" &&
        (item as Record<string, unknown>).description !== ""
    )
    .map((item) => ({
      title: item.title as string,
      description: item.description as string,
      rationale: typeof item.rationale === "string" ? item.rationale : "",
    }));
}
