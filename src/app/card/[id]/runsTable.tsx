"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { MetricsPanel, type Iteration, type Run } from "./metricsPanel";
import { formatDurationMs } from "../../ui/formatDuration";
import { reasoningLevelForKind } from "./reasoningLevel";
import { iterationTask, type IterationTask } from "./iterationTask";
import type { CardDetailData, Plan } from "./useCardDetail";
import { timeAgo } from "../../ui/api";
import { formatCostUsd, sumReported } from "../../ui/formatCost";
import { formatTokens, runTotals } from "./runTotals";
import { formatProviderModel } from "../../ui/formatProviderModel";
import { useNow } from "../../ui/useNow";

export type TranscriptTarget = {
  runId: string;
  iteration: number;
  /** Whether the run is still executing, so the view should follow pushes. */
  live: boolean;
  provider?: string | null;
  model?: string | null;
  reasoningLevel?: string | null;
};

const KIND_LABEL = {
  plan: "◔ Planning",
  loop: "⚙ Loop",
  evaluate: "🔎 Evaluator",
  critique: "⚖ Critic",
} as const;

/** Milliseconds the run was actually executing — `nowMs` keeps a live run's
 * cell ticking; a run with no end and no clock contributes nothing. */
function runDurationMs(run: Run, nowMs: number): number | null {
  const end = run.endedAt ? new Date(run.endedAt).getTime() : run.status === "running" ? nowMs : null;
  return end === null ? null : end - new Date(run.startedAt).getTime();
}

const TASK_STATE_CLASS: Record<IterationTask["state"], string> = {
  done: "bg-green-900/60 text-green-300",
  working: "bg-amber-900/60 text-amber-300",
  "not done": "bg-foreground/10 text-foreground/60",
};

function statusClass(status: string): string {
  if (status === "completed") return "bg-green-900/60 text-green-300";
  if (status === "running") return "bg-amber-900/60 text-amber-300";
  // A pause is the operator's doing, not a failure — never red.
  if (status === "paused") return "bg-sky-900/60 text-sky-300";
  return "bg-red-900/60 text-red-300";
}

/**
 * Every run of a card — planning, loop, and evaluator alike — as one table,
 * with the token and cost columns each kind has always recorded but only the
 * loop used to show. Each row expands into what "summary" means for its kind:
 * a loop's per-iteration metrics, the plan a planning run wrote, the verdict
 * an evaluator reached.
 */
export function RunsTable({
  runs,
  plans,
  models,
  cardSummary,
  weakerIsolationRunIds,
  onOpenTranscript,
}: {
  runs: Run[];
  plans: Plan[];
  models: CardDetailData["models"];
  cardSummary: string | null;
  weakerIsolationRunIds: Set<string | null>;
  onOpenTranscript: (target: TranscriptTarget) => void;
}) {
  // Oldest first: the rows then read as the pipeline actually ran —
  // plan, loop, evaluate — with the card's totals underneath.
  const ordered = useMemo(() => [...runs].reverse(), [runs]);
  const anyRunning = ordered.some((run) => run.status === "running");
  const nowMs = useNow(anyRunning);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // A run that is executing right now opens on its own, so watching a live
  // loop still costs no clicks — the iteration list used to be always-on.
  // Each id auto-opens once; collapsing it afterwards sticks.
  const autoExpanded = useRef(new Set<string>());
  useEffect(() => {
    const fresh = ordered
      .filter((run) => run.status === "running" && !autoExpanded.current.has(run.id))
      .map((run) => run.id);
    if (fresh.length === 0) return;
    for (const id of fresh) autoExpanded.current.add(id);
    setExpanded((prev) => new Set([...prev, ...fresh]));
  }, [ordered]);

  function toggle(runId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });
  }

  // The card summary is written by whichever evaluator ran last, so it is
  // shown under that run rather than repeated under every evaluate row.
  const lastEvaluateId = ordered.filter((run) => run.kind === "evaluate").at(-1)?.id;

  const totalIterations = ordered.reduce((sum, run) => sum + run.iterations.length, 0);
  const totalDurationMs = sumReported(ordered.map((run) => runDurationMs(run, nowMs)));
  const perRunTotals = ordered.map(runTotals);
  const totalPrompt = sumReported(perRunTotals.map((t) => t.promptTokens));
  const totalCompletion = sumReported(perRunTotals.map((t) => t.completionTokens));
  const totalCost = sumReported(perRunTotals.map((t) => t.costUsd));

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] text-sm">
        <caption className="sr-only">
          Every run of this task with its tokens and cost
        </caption>
        <thead>
          <tr className="border-b border-foreground/10 text-left text-xs uppercase tracking-wider text-foreground/40">
            {["Run", "Status", "Model", "Iters", "Duration", "Prompt", "Completion", "Cost", "Started"].map((label, i) => (
              <th key={label} scope="col" className={`py-2 font-medium ${i < 8 ? "pr-3" : ""} ${i >= 3 ? "text-right" : ""}`}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map((run, index) => {
            const totals = perRunTotals[index];
            const isOpen = expanded.has(run.id);
            const durationMs = runDurationMs(run, nowMs);
            return [
              <tr key={run.id} className="border-b border-foreground/5 align-top">
                <td className="py-2 pr-3">
                  <button
                    type="button"
                    onClick={() => toggle(run.id)}
                    aria-expanded={isOpen}
                    aria-controls={`run-detail-${run.id}`}
                    className="flex items-start gap-1.5 text-left text-foreground/85 hover:text-foreground"
                  >
                    <span aria-hidden className="mt-px w-3 shrink-0 text-foreground/40">
                      {isOpen ? "▾" : "▸"}
                    </span>
                    <span className="font-medium">{KIND_LABEL[run.kind]}</span>
                  </button>
                  {run.exitReason && (
                    <p className="mt-0.5 pl-[1.125rem] text-xs text-foreground/45">{run.exitReason}</p>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <span className={`text-xs rounded px-1.5 py-0.5 ${statusClass(run.status)}`}>
                    {run.status}
                  </span>
                  {weakerIsolationRunIds.has(run.id) && (
                    <span
                      className="ml-1 inline-block rounded border border-amber-700/60 bg-amber-950/30 px-1.5 py-0.5 text-xs text-amber-300"
                      title="Ran with sandboxWeakerIsolationForGoTls on: trustd's OCSP/CRL requests bypass the egress proxy (see docs/SANDBOXING.md)."
                    >
                      weaker isolation
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-foreground/50">
                  {formatProviderModel(run.provider, run.model, reasoningLevelForKind(run.kind, models))}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-foreground/70">
                  {run.kind === "loop" ? run.iterations.length : "—"}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-foreground/70">
                  {durationMs == null ? "—" : formatDurationMs(durationMs)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-foreground/70">
                  {formatTokens(totals.promptTokens)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-foreground/70">
                  {formatTokens(totals.completionTokens)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-foreground/70">
                  {formatCostUsd(totals.costUsd)}
                </td>
                <td className="py-2 text-right text-xs text-foreground/40">
                  {timeAgo(run.startedAt)} ago
                </td>
              </tr>,
              isOpen ? (
                <tr key={`${run.id}-detail`} className="border-b border-foreground/5">
                  <td id={`run-detail-${run.id}`} colSpan={9} className="pb-3">
                    <div className="rounded bg-foreground/[0.04] p-3">
                      <RunDetail
                        run={run}
                        plans={plans}
                        cardSummary={run.id === lastEvaluateId ? cardSummary : null}
                        reasoningLevel={reasoningLevelForKind(run.kind, models)}
                        nowMs={nowMs}
                        onOpenTranscript={onOpenTranscript}
                      />
                    </div>
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-foreground/20 font-medium text-foreground/80">
            <td className="py-2 pr-3">Total</td>
            <td className="py-2 pr-3" />
            <td className="py-2 pr-3" />
            <td className="py-2 pr-3 text-right tabular-nums">{totalIterations}</td>
            <td className="py-2 pr-3 text-right tabular-nums">
              {totalDurationMs == null ? "—" : formatDurationMs(totalDurationMs)}
            </td>
            <td className="py-2 pr-3 text-right font-mono text-xs">{formatTokens(totalPrompt)}</td>
            <td className="py-2 pr-3 text-right font-mono text-xs">{formatTokens(totalCompletion)}</td>
            <td className="py-2 pr-3 text-right font-mono text-xs">{formatCostUsd(totalCost)}</td>
            <td className="py-2" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** What a run's expanded row shows, which is a different artifact per kind:
 * a loop has iterations, a planning run has the plan it wrote, an evaluator
 * has its verdict. All three offer the transcript, and any of them can be
 * carrying the merge review — see ReviewBlock. */
function RunDetail({
  run,
  plans,
  cardSummary,
  reasoningLevel,
  nowMs,
  onOpenTranscript,
}: {
  run: Run;
  plans: Plan[];
  cardSummary: string | null;
  reasoningLevel: string | undefined;
  nowMs: number;
  onOpenTranscript: (target: TranscriptTarget) => void;
}) {
  const open = (iteration: number) =>
    onOpenTranscript({
      runId: run.id,
      iteration,
      live: run.status === "running",
      provider: run.provider,
      model: run.model,
      reasoningLevel,
    });

  if (run.kind === "loop") {
    return (
      <div className="flex flex-col gap-2">
        {run.iterations.length > 0 ? (
          <MetricsPanel run={run} nowMs={nowMs} />
        ) : (
          <p className="text-xs text-foreground/50">No iterations recorded for this run.</p>
        )}
        <div className="flex flex-col gap-0.5">
          {run.iterations.map((it: Iteration) => {
            const task = iterationTask(it);
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => open(it.n)}
                className="flex gap-2 text-left text-xs text-foreground/60 hover:text-foreground"
              >
                <span className="shrink-0 text-amber-400/80">iter {it.n}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  {task && (
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-foreground/80">{task.label}</span>
                      <span className={`rounded px-1 ${TASK_STATE_CLASS[task.state]}`}>{task.state}</span>
                      <span className="text-foreground/40">
                        {task.left === 0 ? "none left" : `${task.left} left`}
                      </span>
                      <span className="basis-full whitespace-pre-wrap text-foreground/70">{task.text}</span>
                    </span>
                  )}
                  <span className={it.status === "failed" ? "text-red-400" : ""}>
                    {(it.summary ?? it.status).slice(0, 140)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <ReviewBlock run={run} />
        <TranscriptButton run={run} onClick={() => open(run.iterations.at(-1)?.n ?? 1)} />
      </div>
    );
  }

  if (run.kind === "plan") {
    const plan = plans.find((p) => p.id === run.planId);
    return (
      <div className="flex flex-col gap-2">
        {plan ? (
          <div>
            <p className="text-xs font-medium text-foreground/70">
              Plan v{plan.version}
              <span className="ml-2 font-normal text-foreground/40">acceptance criteria</span>
            </p>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-foreground/[0.04] p-2 font-mono text-xs">
              {plan.acceptanceCriteria.trim() || plan.planMd.trim()}
            </pre>
          </div>
        ) : (
          <p className="text-xs text-foreground/50">
            This run wrote no plan — the transcript has why.
          </p>
        )}
        <ReviewBlock run={run} />
        <TranscriptButton run={run} onClick={() => open(0)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-foreground/70">
        Verdict
        <span
          className={`ml-2 rounded px-1.5 py-0.5 font-normal ${
            run.exitReason === "approve"
              ? "bg-green-900/60 text-green-300"
              : "bg-foreground/10 text-foreground/70"
          }`}
        >
          {run.exitReason ?? "none recorded"}
        </span>
      </p>
      {cardSummary && (
        <div>
          <p className="text-xs font-medium text-foreground/70">Summary</p>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-foreground/[0.04] p-2 font-mono text-xs">
            {cardSummary}
          </pre>
        </div>
      )}
      <ReviewBlock run={run} />
      <TranscriptButton run={run} onClick={() => open(0)} />
    </div>
  );
}

/**
 * The merge review, shown under whichever run is carrying it.
 *
 * `reviews.run_id` is not the evaluate run: reviewService writes it against
 * `latestWorktreeRun`, the most recent run whose worktree still exists
 * regardless of kind (orchestrator.ts), so in practice it usually lands on
 * the loop run. Rendering it wherever it actually is beats guessing.
 */
function ReviewBlock({ run }: { run: Run }) {
  const review = run.reviews?.[0];
  if (!review) return null;
  return (
    <div>
      <p className="text-xs font-medium text-foreground/70">
        Merge review
        <span
          className={`ml-2 rounded px-1.5 py-0.5 font-normal ${
            review.decision === "approved"
              ? "bg-green-900/60 text-green-300"
              : "bg-red-900/60 text-red-300"
          }`}
        >
          {review.decision}
        </span>
        {review.mergeCommit && (
          <span className="ml-2 font-mono font-normal text-foreground/40">
            merged {review.mergeCommit.slice(0, 7)}
          </span>
        )}
      </p>
      {review.feedback && (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-foreground/[0.04] p-2 font-mono text-xs">
          {review.feedback}
        </pre>
      )}
    </div>
  );
}

function TranscriptButton({ run, onClick }: { run: Run; onClick: () => void }) {
  const live = run.status === "running";
  return (
    <button
      type="button"
      onClick={onClick}
      className="self-start text-xs text-amber-400 hover:underline"
    >
      {live ? "● watch live" : "view transcript"}
    </button>
  );
}
