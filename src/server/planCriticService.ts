import { and, desc, eq } from "drizzle-orm";
import { db, runs, type ScopingRole } from "@/db";
import type { ScopingMessage } from "./scoping";

/** Where the critic writes its verdict, relative to the worktree's .ralph/. */
export const CRITIQUE_FILE = "CRITIQUE.md";

/**
 * Spec 30: whether a card's plan goes through the critic. A per-card override
 * (`planCritic` 1/0) wins outright; otherwise the workspace mode decides —
 * `always`, `breakdown` (only cards produced by a breakdown, i.e. with a
 * parent), or `off`.
 */
export function criticEnabled(
  card: { planCritic: number | null; parentCardId: string | null },
  settings: { planCriticMode: string },
): boolean {
  if (card.planCritic !== null) return Boolean(card.planCritic);
  if (settings.planCriticMode === "always") return true;
  if (settings.planCriticMode === "breakdown") return card.parentCardId !== null;
  return false;
}

/** Spec file paths (`specs/<name>.md`) named anywhere in the given texts,
 * unique and in order of first appearance. */
export function namedSpecFiles(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\bspecs\/[\w.-]+\.md\b/g)) {
      seen.add(match[0]);
    }
  }
  return [...seen];
}

// Same speaker names the planner sees, so the critic reads the thread the
// way the plan it is judging was written from.
const SCOPING_SPEAKER: Record<ScopingRole, string> = {
  user: "Operator",
  assistant: "Scoping assistant",
  planner: "Planner (an earlier planning run)",
  loop: "Implementation loop (blocked)",
};

const CRITIQUE_PATH = `.ralph/${CRITIQUE_FILE}`;

export function renderCriticPrompt(
  template: string,
  input: {
    title: string;
    description: string;
    scoping: Pick<ScopingMessage, "role" | "content">[];
    specFiles: string[];
    planVersion: number;
    planMd: string;
    criteriaMd: string;
    promptMd: string;
  },
): string {
  const scopingSection = input.scoping.length
    ? `\nSCOPING THREAD\n==============\nThe operator scoped this card in conversation before planning. Decisions\nreached below are part of the card; where they and the description disagree,\nthe thread is the newer of the two.\n\n${input.scoping.map((m) => `${SCOPING_SPEAKER[m.role]}: ${m.content}`).join("\n\n")}\n`
    : "";
  const specFiles = input.specFiles.length
    ? input.specFiles.join("\n")
    : "(the card names no spec files)";
  const rendered = template
    .replaceAll("{{TITLE}}", input.title)
    .replaceAll("{{DESCRIPTION}}", input.description || "(no description)")
    .replaceAll("{{SCOPING_SECTION}}", scopingSection)
    .replaceAll("{{SPEC_FILES}}", specFiles)
    .replaceAll("{{PLAN_VERSION}}", String(input.planVersion))
    .replaceAll("{{PLAN_MD}}", input.planMd)
    .replaceAll("{{CRITERIA_MD}}", input.criteriaMd)
    .replaceAll("{{PROMPT_MD}}", input.promptMd);
  // A customized template that forgot the verdict file would leave the stage
  // with nothing to parse, so the instruction is guaranteed rather than trusted.
  return rendered.includes(CRITIQUE_PATH)
    ? rendered
    : `${rendered}\nWrite your verdict to ${CRITIQUE_PATH} and nothing else.\n`;
}

/**
 * How many times in a row the critic has sent the card's plan back since the
 * loop last ran — the count the revision cap is measured against. A loop run
 * resets it: revisions before the latest loop belong to an earlier cycle.
 */
export function consecutiveCriticRevisions(cardId: string): number {
  const latestLoop = db
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(and(eq(runs.cardId, cardId), eq(runs.kind, "loop")))
    .orderBy(desc(runs.startedAt))
    .limit(1)
    .get();
  const revisions = db
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(and(eq(runs.cardId, cardId), eq(runs.kind, "critique"), eq(runs.exitReason, "revise")))
    .all();
  if (!latestLoop) return revisions.length;
  return revisions.filter((r) => r.startedAt > latestLoop.startedAt).length;
}
