"use client";
import { useEffect, useRef } from "react";

export type { CardStatus } from "@/shared/cardStatus";
import type { CardStatus } from "@/shared/cardStatus";
import type { EpicRunMode } from "@/shared/epics";

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
  /** Spec 24: the epic this card is a piece of, and how an epic's pieces run. */
  parentCardId: string | null;
  runMode: EpicRunMode | null;
  dependsOn: string[] | null;
  latestRun: {
    id: string;
    kind: "plan" | "loop" | "evaluate" | "critique";
    status: string;
    iterationsDone: number;
    exitReason: string | null;
    currentTask: { number: number; count: number; left: number; text: string } | null;
    startedAt: string;
  } | null;
  maxIterationsResolved: number;
  plannerModelResolved: string | null;
  loopModelResolved: string | null;
  evaluatorModelResolved: string | null;
  summary: string | null;
};

export type { Repo } from "@/server/repos";
export type { ImprovementRunStatus } from "@/db/schema";
export type { ImprovementRun } from "@/server/improvementRuns";

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

type StreamEvent = { type: string; cardId: string | null; payload?: string };
type StreamSubscriber = {
  onEvent: (e: StreamEvent) => void;
  onConnectionChange: (connected: boolean) => void;
};

// One EventSource per tab, shared by every useEventStream caller. The board
// and a card page's two subscribers would otherwise each hold a connection,
// and a few open tabs exhaust the browser's per-origin HTTP/1.1 limit under
// `next dev`. Opened by the first subscriber, closed when the last leaves.
let sharedStream: EventSource | null = null;
let sharedConnected: boolean | null = null;
const subscribers = new Set<StreamSubscriber>();

// One subscriber's throwing callback must not starve the others of the frame;
// a per-subscriber stream used to swallow it the same way.
function dispatch(fn: () => void): void {
  try {
    fn();
  } catch {
    // ignore
  }
}

function subscribeToStream(subscriber: StreamSubscriber): () => void {
  subscribers.add(subscriber);
  if (sharedStream) {
    // A late subscriber gets the same open/error callback its own stream
    // would have fired by now.
    if (sharedConnected !== null) dispatch(() => subscriber.onConnectionChange(sharedConnected!));
  } else {
    const es = new EventSource("/api/events/stream");
    es.onopen = () => {
      sharedConnected = true;
      subscribers.forEach((s) => dispatch(() => s.onConnectionChange(true)));
    };
    es.onerror = () => {
      sharedConnected = false;
      subscribers.forEach((s) => dispatch(() => s.onConnectionChange(false)));
    };
    es.onmessage = (msg) => {
      let event: StreamEvent;
      try {
        event = JSON.parse(msg.data);
      } catch {
        return; // ignore malformed frames
      }
      subscribers.forEach((s) => dispatch(() => s.onEvent(event)));
    };
    sharedStream = es;
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      sharedStream?.close();
      sharedStream = null;
      sharedConnected = null;
    }
  };
}

/** Subscribe to the server event stream; call onEvent for each event row. */
export function useEventStream(
  onEvent: (e: StreamEvent) => void,
  onConnectionChange?: (connected: boolean) => void
) {
  const cb = useRef(onEvent);
  const connectionCb = useRef(onConnectionChange);
  useEffect(() => {
    cb.current = onEvent;
    connectionCb.current = onConnectionChange;
  });
  useEffect(() => subscribeToStream({
    onEvent: (event) => cb.current(event),
    onConnectionChange: (connected) => connectionCb.current?.(connected),
  }), []);
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
