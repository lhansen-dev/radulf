"use client";
import { formatDuration } from "./formatDuration";
import { useNow } from "../../ui/useNow";

export type Iteration = {
  id: number;
  runId: string;
  n: number;
  status: string;
  summary: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  startedAt: string;
  endedAt: string | null;
};

export type Run = {
  id: string;
  kind: "plan" | "loop" | "evaluate";
  status: string;
  iterationsDone: number;
  exitReason: string | null;
  startedAt: string;
  endedAt: string | null;
  provider?: string | null;
  model?: string | null;
  iterations: Iteration[];
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

  return (
    <div className="mt-2 mb-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-xs text-foreground/70">
          <thead>
            <tr className="border-b border-foreground/10 text-foreground/50">
              <th className="text-left py-1 pr-2 font-medium">Iter</th>
              <th className="text-left py-1 pr-2 font-medium">Duration</th>
              <th className="text-right py-1 pr-2 font-medium">Prompt</th>
              <th className="text-right py-1 font-medium">Completion</th>
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
                <td className="py-1 text-right font-mono">
                  {it.completionTokens ?? 0}
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
              <td className="py-1 text-right font-mono">{totalCompletion}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}