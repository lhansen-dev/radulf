"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, useEventStream, type BoardCard, type CardStatus } from "./api";
import { refreshTargetsForEvent } from "./eventRefresh";
import { ActivityDot } from "./liveActivity";
import { taskIdFromPath, useOpenTasks } from "./openTasks";
import { ATTENTION_STATUSES, RUNNING_STATUSES, STATUS_LABELS } from "@/shared/cardStatus";

function statusDotTone(status: CardStatus | undefined): string {
  if (!status) return "bg-foreground/20";
  if (status === "done") return "bg-green-400";
  if (RUNNING_STATUSES.includes(status)) return "bg-amber-400";
  if (ATTENTION_STATUSES.includes(status)) return "bg-violet-400";
  return "bg-slate-400";
}

/**
 * A strip of the tasks the operator has open, so switching between several
 * running tasks is one click here rather than a browser tab each. Visiting a
 * task's page adds it; the × closes it. Rendered only once something is
 * open, so a fresh browser sees nothing extra.
 */
export function OpenTasksStrip({ pathname }: { pathname: string }) {
  const { ids, close, prune } = useOpenTasks(pathname);
  if (ids.length === 0) return null;
  return <OpenTasksBar ids={ids} current={taskIdFromPath(pathname)} onClose={close} onLoaded={prune} />;
}

function OpenTasksBar({
  ids,
  current,
  onClose,
  onLoaded,
}: {
  ids: string[];
  current: string | null;
  onClose: (id: string) => void;
  onLoaded: (existing: Set<string>) => void;
}) {
  const [cards, setCards] = useState<Map<string, BoardCard>>(new Map());
  const load = useCallback(() => {
    api<BoardCard[]>("/api/cards")
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        setCards(new Map(rows.map((card) => [card.id, card])));
        onLoaded(new Set(rows.map((card) => card.id)));
      })
      .catch(() => {});
  }, [onLoaded]);
  useEffect(load, [load]);
  // The same refresh rule as the feed: card lifecycle events, debounced.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEventStream((event) => {
    if (!refreshTargetsForEvent(event.type).includes("cards")) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 150);
  });

  return (
    <nav aria-label="Open tasks" className="flex gap-1.5 overflow-x-auto border-b border-foreground/[0.08] px-4 py-1.5 sm:px-6">
      {ids.map((id) => {
        const card = cards.get(id);
        const active = id === current;
        const title = card?.title ?? "Loading…";
        return (
          <div
            key={id}
            className={`flex shrink-0 items-center rounded-lg border ${active ? "border-amber-500/60 bg-amber-500/10" : "border-foreground/10 bg-foreground/[0.03] hover:bg-foreground/[0.06]"}`}
          >
            <Link
              href={card?.status === "review" ? `/review/${id}` : `/card/${id}`}
              aria-current={active ? "page" : undefined}
              title={card ? `${title} · ${STATUS_LABELS[card.status]}` : title}
              className="flex min-h-9 max-w-56 items-center gap-2 pl-2.5 pr-1 text-sm"
            >
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${statusDotTone(card?.status)}`} />
              <span className="truncate">{title}</span>
              {card && RUNNING_STATUSES.includes(card.status) && <ActivityDot runId={card.latestRun?.id ?? null} />}
            </Link>
            <button
              type="button"
              onClick={() => onClose(id)}
              aria-label={`Close ${title}`}
              className="min-h-9 px-2 text-foreground/40 hover:text-foreground"
            >
              ×
            </button>
          </div>
        );
      })}
    </nav>
  );
}
