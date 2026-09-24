"use client";
import Link from "next/link";
import { api } from "../../ui/api";
import type { ChildCard } from "./useCardDetail";
import { ATTENTION_STATUSES, RUNNING_STATUSES, STATUS_LABELS, type CardStatus } from "@/shared/cardStatus";
import type { EpicRunMode } from "@/shared/epics";
import { errorMessage } from "@/shared/errorMessage";

function statusTone(status: string): string {
  if (status === "done") return "text-green-300";
  if (RUNNING_STATUSES.includes(status as CardStatus)) return "text-amber-300";
  if (ATTENTION_STATUSES.includes(status as CardStatus)) return "text-violet-300";
  return "text-foreground/45";
}

/**
 * Spec 24: an epic's pieces on its own page, in queue order, with the run
 * mode the queue applies to them. Start all and Pause all sit with the other
 * header actions; this is the reading view plus the one setting.
 */
export function EpicTasks({
  cardId,
  runMode,
  tasks,
  onChanged,
  onError,
}: {
  cardId: string;
  runMode: EpicRunMode | null;
  tasks: ChildCard[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const done = tasks.filter((task) => task.status === "done").length;
  const setMode = async (mode: EpicRunMode) => {
    try {
      await api(`/api/cards/${cardId}`, { method: "PATCH", json: { runMode: mode } });
      onChanged();
    } catch (e) {
      onError(errorMessage(e));
    }
  };
  return (
    <section aria-labelledby="epic-tasks-title" className="flex flex-col gap-2 rounded-lg border border-foreground/10 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="epic-tasks-title" className="text-sm font-medium">
          Tasks in this epic <span className="font-normal text-foreground/45">{done} of {tasks.length} done</span>
        </h3>
        <label className="ml-auto flex items-center gap-2 text-xs text-foreground/70">
          Run mode
          <select
            aria-label="Run mode"
            value={runMode ?? "ordered"}
            onChange={(e) => void setMode(e.target.value as EpicRunMode)}
            className="min-h-9 rounded-lg border border-foreground/10 bg-foreground/5 px-2 text-sm"
          >
            <option value="ordered">In order</option>
            <option value="parallel">In parallel</option>
            <option value="graph">As a graph</option>
          </select>
        </label>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
        <div className="h-full bg-green-400" style={{ width: `${tasks.length ? Math.round((done / tasks.length) * 100) : 0}%` }} />
      </div>
      <ol className="flex flex-col divide-y divide-foreground/[0.06]">
        {tasks.map((task, i) => (
          <li key={task.id} className="flex min-h-11 items-center gap-3 text-sm">
            <span className="w-5 shrink-0 text-right tabular-nums text-foreground/40">{i + 1}</span>
            <Link href={`/card/${task.id}`} className="min-w-0 grow truncate hover:underline">{task.title}</Link>
            <span className={`shrink-0 text-xs ${statusTone(task.status)}`}>
              {(STATUS_LABELS as Record<string, string>)[task.status] ?? task.status}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
