import { modelTag } from "@/server/modelTag";

/**
 * Extract the model tag from the first plan run in the runs array.
 *
 * The API returns runs newest-first, so the first plan run is the most
 * recent planning run. Returns null when no plan run exists.
 */
export function plannerModelTag(
  runs: { kind: string; provider?: string | null; model?: string | null }[],
): string | null {
  const planRun = runs.find((r) => r.kind === "plan");
  if (!planRun) return null;
  return modelTag(planRun.provider ?? "", planRun.model);
}

/**
 * A small badge that displays "Planned by: <tag>".
 *
 * Renders nothing when tag is null or empty.
 */
export function PlanModelBadge({ tag }: { tag: string | null }) {
  if (!tag) return null;
  return (
    <p className="text-xs text-foreground/50">
      Planned by: <span className="text-foreground/80 font-medium">{tag}</span>
    </p>
  );
}
