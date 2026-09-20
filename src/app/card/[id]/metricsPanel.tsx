"use client";
import { formatDuration } from "./formatDuration";
import { formatCostUsd, sumCostUsd } from "../../ui/formatCost";
import { useNow } from "../../ui/useNow";

export type Iteration = {
  id: number;
  runId: string;
  n: number;
  status: string;
  summary: string | null;
  /** The checklist task this iteration was given — see `iterationTask`.
   * Absent on rows recorded before tasks were tracked per iteration. */
  taskNumber?: number | null;
  taskCount?: number | null;
  taskText?: string | null;
  taskCompleted?: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Harness-reported USD for the iteration; absent on pre-telemetry rows. */
  costUsd?: number | null;
  startedAt: string;
  endedAt: string | null;
};

/** An evaluator verdict, one per evaluate run (`reviews.run_id` is unique). */
export type Review = {
  id: string;
  runId: string;
  decision: "approved" | "rejected";
  feedback: string | null;
  mergeCommit: string | null;
  createdAt: string;
};

export type Run = {
  id: string;
  /** The plan a `plan` run wrote, when it got far enough to write one. */
  planId?: string | null;
  kind: "plan" | "loop" | "evaluate";
  status: string;
  iterationsDone: number;
  exitReason: string | null;
  /** Spec 18 §3: what the exit reason said about the provider. "config" means
   * the request itself was rejected, so no retry can change the outcome. */
  failureKind?: string | null;
  startedAt: string;
  endedAt: string | null;
  provider?: string | null;
  model?: string | null;
  /** Run-level telemetry roll-up, recorded for every kind — a plan or
   * evaluate run is its single harness invocation's numbers, a loop run is
   * the sum of its iterations. Written when the run finishes, so these are
   * null while it is still in flight (and on pre-telemetry rows). */
  promptTokens?: number | null;
  completionTokens?: number | null;
  costUsd?: number | null;
  iterations: Iteration[];
  reviews?: Review[];
};

export function MetricsPanel({ run }: { run: Run }) {
  const { iterations } = run;
  const nowMs = useNow(run.status === "running");
  const totalPrompt = iterations.reduce(
    (s, it) => s + (it.promptTokens ?? 0),
    0,
  );
  const totalCompletion = iterations.reduce(
    (s, it) => s + (it.completionTokens ?? 0),
    0,
  );
  const totalCost = sumCostUsd(iterations.map((it) => it.costUsd));

  return (
    <div className="mt-2 mb-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-xs text-foreground/70">
          <thead>
            <tr className="border-b border-foreground/10 text-foreground/50">
              <th className="text-left py-1 pr-2 font-medium">Iter</th>
              <th className="text-left py-1 pr-2 font-medium">Duration</th>
              <th className="text-right py-1 pr-2 font-medium">Prompt</th>
              <th className="text-right py-1 pr-2 font-medium">Completion</th>
              <th className="text-right py-1 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {iterations.map((it) => (
              <tr key={it.id} className="border-b border-foreground/5">
                <td className="py-1 pr-2 text-amber-400/80">{it.n}</td>
                <td className="py-1 pr-2">
                  {formatDuration(it.startedAt, it.endedAt, it.endedAt ? undefined : nowMs)}
                </td>
                <td className="py-1 pr-2 text-right font-mono">
                  {it.promptTokens ?? 0}
                </td>
                <td className="py-1 pr-2 text-right font-mono">
                  {it.completionTokens ?? 0}
                </td>
                <td className="py-1 text-right font-mono">
                  {formatCostUsd(it.costUsd)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium border-t border-foreground/20 text-foreground/80">
              <td className="py-1 pr-2">Total</td>
              <td className="py-1 pr-2">
                {formatDuration(run.startedAt, run.endedAt, nowMs)}
              </td>
              <td className="py-1 pr-2 text-right font-mono">{totalPrompt}</td>
              <td className="py-1 pr-2 text-right font-mono">{totalCompletion}</td>
              <td className="py-1 text-right font-mono">{formatCostUsd(totalCost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}