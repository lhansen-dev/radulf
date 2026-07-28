export type RefreshTarget = "cards" | "repos" | "improvementRuns";

export function refreshTargetsForEvent(type: string): RefreshTarget[] {
  if (type.startsWith("repo.")) return ["repos", "cards"];
  if (type.startsWith("improvement.")) return ["improvementRuns"];
  if (
    type.startsWith("card.") ||
    type.startsWith("run.") ||
    type.startsWith("iteration.") ||
    type.startsWith("plan.") ||
    type.startsWith("review.")
  ) {
    // Card lifecycle events are also how an in-flight improvement run's
    // current task and succeeded/failure counters advance (the driver has no
    // dedicated event for those) — refresh both.
    return ["cards", "improvementRuns"];
  }
  return [];
}
