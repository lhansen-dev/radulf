"use client";
import { useEffect, useRef } from "react";

export type CardStatus =
  | "backlog"
  | "todo"
  | "planning"
  | "ready"
  | "looping"
  | "evaluating"
  | "paused"
  | "review"
  | "reviewing"
  | "plan_review"
  | "needs_attention"
  | "done"
  | "abandoned";

export type BoardCard = {
  id: string;
  repoId: string;
  title: string;
  description: string;
  status: CardStatus;
  position: number;
  source: "user" | "agent";
  maxIterations: number | null;
  timeoutMinutes: number | null;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
  repoName: string;
  baseBranch: string | null;
  latestRun: {
    id: string;
    kind: "plan" | "loop" | "evaluate";
    status: string;
    iterationsDone: number;
    exitReason: string | null;
    currentTask: string | null;
    startedAt: string;
  } | null;
  maxIterationsResolved: number;
  plannerModelResolved: string | null;
  loopModelResolved: string | null;
  evaluatorModelResolved: string | null;
  summary: string | null;
};

export type Repo = {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  createdAt: string;
};

export type ImprovementRunStatus = "running" | "completed" | "stopped" | "failed";

export type ImprovementRun = {
  id: string;
  repoId: string;
  status: ImprovementRunStatus;
  featureBranch: string;
  baseBranch: string;
  focusPrompt: string | null;
  plannerModel: string | null;
  loopModel: string | null;
  evaluatorModel: string | null;
  maxIterations: number | null;
  timeoutMinutes: number | null;
  deadlineAt: string;
  currentCardId: string | null;
  tasksCreated: number;
  tasksSucceeded: number;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};

export type PlannerMessage = { role: "user" | "assistant"; content: string };

export async function api<T = unknown>(
  url: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> {
  const opts: RequestInit = { ...init };
  if (init?.json !== undefined) {
    opts.method = init.method ?? "POST";
    opts.headers = { "Content-Type": "application/json", ...init.headers };
    opts.body = JSON.stringify(init.json);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${url}`);
  return data as T;
}

/** Subscribe to the server event stream; call onEvent for each event row. */
export function useEventStream(
  onEvent: (e: { type: string; cardId: string | null; payload?: string }) => void,
  onConnectionChange?: (connected: boolean) => void
) {
  const cb = useRef(onEvent);
  const connectionCb = useRef(onConnectionChange);
  useEffect(() => {
    cb.current = onEvent;
    connectionCb.current = onConnectionChange;
  });
  useEffect(() => {
    const es = new EventSource("/api/events/stream");
    es.onopen = () => connectionCb.current?.(true);
    es.onerror = () => connectionCb.current?.(false);
    es.onmessage = (msg) => {
      try {
        cb.current(JSON.parse(msg.data));
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, []);
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
