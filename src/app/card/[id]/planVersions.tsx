"use client";
import { useState } from "react";
import { timeAgo } from "../../ui/api";
import type { CardDetailData, Plan } from "./useCardDetail";

/**
 * Every version of a card's plan, newest first, each with its PLAN.md,
 * CRITERIA.md and PROMPT.md. The newest version's PLAN.md is the live
 * checklist the loop is ticking off, when there is one; older versions show
 * the checklist as it stood when that version was written.
 */
export function PlanVersions({
  plans,
  livePlan,
}: {
  plans: Plan[];
  livePlan: CardDetailData["livePlan"];
}) {
  // null follows the newest version, so a fresh plan replaces the one shown
  // unless an older version was picked on purpose.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const latest = plans[0];
  const plan = plans.find((p) => p.id === selectedId) ?? latest;
  const live = plan.id === latest.id ? livePlan ?? null : null;

  return (
    <div className="flex flex-col gap-2">
      {plans.length > 1 && (
        <div className="flex flex-wrap gap-1" aria-label="Plan versions">
          {plans.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={p.id === plan.id}
              onClick={() => setSelectedId(p.id === latest.id ? null : p.id)}
              className={`rounded px-2 py-0.5 text-xs ${
                p.id === plan.id
                  ? "bg-amber-600 text-on-accent"
                  : "bg-foreground/10 text-foreground/70 hover:text-foreground"
              }`}
            >
              v{p.version}
              {p.id === latest.id && " · latest"}
            </button>
          ))}
        </div>
      )}

      <p className="text-xs text-foreground/50">
        Plan v{plan.version} · written {timeAgo(plan.createdAt)} ago
        {plan.origin === "scoping" && " · by the scoping session, skipping the planner"}
      </p>

      {plan.feedback && (
        <div className="rounded border border-amber-700/40 bg-amber-950/20 p-2">
          <p className="text-xs font-medium text-amber-300">Written in response to feedback</p>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-sans text-xs text-amber-100/80">
            {plan.feedback}
          </pre>
        </div>
      )}

      {live && live.total > 0 && (
        <div>
          <p className="text-xs text-foreground/60">
            {live.done} of {live.total} tasks done · {live.total - live.done} left
          </p>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded bg-foreground/10"
            role="progressbar"
            aria-label="Plan progress"
            aria-valuemin={0}
            aria-valuemax={live.total}
            aria-valuenow={live.done}
          >
            <div className="h-full bg-green-500/70" style={{ width: `${(live.done / live.total) * 100}%` }} />
          </div>
        </div>
      )}

      {(
        [
          ["PLAN.md", live?.planMd ?? plan.planMd, live ? "live checklist" : null],
          ["CRITERIA.md", plan.acceptanceCriteria, null],
          ["PROMPT.md", plan.promptMd, null],
        ] as const
      ).map(([name, content, note]) => (
        <details key={`${plan.id}-${name}`} open={name === "PLAN.md"}>
          <summary className="cursor-pointer text-sm font-medium text-foreground/80">
            {name}{" "}
            <span className="text-foreground/40">
              (plan v{plan.version}
              {note && `, ${note}`})
            </span>
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-foreground/[0.04] p-3 font-mono text-xs">
            {content}
          </pre>
        </details>
      ))}
    </div>
  );
}
