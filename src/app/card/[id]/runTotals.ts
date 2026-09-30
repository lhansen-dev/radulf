import type { Run } from "./metricsPanel";
import { sumReported } from "../../ui/formatCost";

/**
 * Prompt/completion/cost for one run row.
 *
 * A loop run is summed from its iterations rather than read off the run row:
 * the run-level roll-up is only written when the run finishes, so an in-flight
 * loop would otherwise read as unmeasured while its numbers are visibly
 * climbing. A finished loop's roll-up is that same sum, so the two agree.
 * Plan and evaluate runs are a single harness invocation with no iteration
 * rows, so their roll-up is the only source.
 */
export function runTotals(run: Run): {
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
} {
  if (run.kind === "loop" && run.iterations.length > 0) {
    return {
      promptTokens: sumReported(run.iterations.map((it) => it.promptTokens)),
      completionTokens: sumReported(run.iterations.map((it) => it.completionTokens)),
      costUsd: sumReported(run.iterations.map((it) => it.costUsd)),
    };
  }
  return {
    promptTokens: run.promptTokens ?? null,
    completionTokens: run.completionTokens ?? null,
    costUsd: run.costUsd ?? null,
  };
}

/** A token count for a cell; an unmeasured null is an em dash, never a zero. */
export function formatTokens(value: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}
