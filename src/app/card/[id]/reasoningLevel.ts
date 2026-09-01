import type { CardDetailData } from "./useCardDetail";

/**
 * The reasoning level for a run's role. Not persisted per run (runHarness
 * reads it straight off settings at call time), so this is always the
 * current global value — not necessarily what an old run actually used.
 */
export function reasoningLevelForKind(
  kind: "plan" | "loop" | "evaluate",
  models: CardDetailData["models"],
): string | undefined {
  if (!models) return undefined;
  if (kind === "plan") return models.planner.reasoningLevel;
  if (kind === "loop") return models.loop.reasoningLevel;
  return models.evaluator.reasoningLevel;
}
