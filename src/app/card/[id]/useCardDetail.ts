"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, useEventStream } from "../../ui/api";
import type { Run } from "./metricsPanel";

export type Plan = {
  id: string;
  version: number;
  planMd: string;
  promptMd: string;
  acceptanceCriteria: string;
  feedback: string | null;
  /** Spec 17: which role wrote it. Absent on rows from before the column. */
  origin?: "planner" | "scoping" | null;
  createdAt: string;
};

/** One entry in the card's scoping thread (spec 17). `planner` is a set of
 * blocking questions a planning run raised, `loop` a blocker the loop hit
 * while carrying the card out; both wait on the operator. */
export type ScopingMessage = {
  id: number;
  role: "user" | "assistant" | "planner" | "loop";
  content: string;
  createdAt: string;
};

/** What a scoping turn was asked for (spec 17's three concrete outputs, plus
 * the next message). */
export type ScopingRequest = "reply" | "proposal" | "split" | "plan";

/** A scoping turn in flight for the card: the server holds one per card, so
 * this is set after a reload or in a second tab as well. */
export type ScopingTurn = { request: ScopingRequest; startedAt: string };

/** Spec 24: one piece of an epic, as its page lists them. */
export type ChildCard = {
  id: string;
  title: string;
  status: string;
  position: number;
  repoId: string;
  startedAt: string | null;
  updatedAt: string;
};

export type CardDetailData = {
  card: {
    id: string;
    title: string;
    description: string;
    status: string;
    maxIterations: number | null;
    timeoutMinutes: number | null;
    plannerModel: string | null;
    loopModel: string | null;
    evaluatorModel: string | null;
    reviewPlanBeforeImplementation: number;
    grillMe: number;
    scopingAuthorsPlan: number;
    /** Spec 30: null inherits the global critic mode, 1 on, 0 off. */
    planCritic: number | null;
    criticModel: string | null;
    autoApprove: number;
    summary: string | null;
    startedAt: string | null;
    createdAt: string;
    baseBranch: string | null;
    /** Spec 24. Absent on older cached responses. */
    parentCardId?: string | null;
    runMode?: "ordered" | "parallel" | null;
  };
  repo: { id: string; name: string; path: string; defaultBranch: string } | null;
  plans: Plan[];
  /** The latest plan's orchestrator-private checklist as it stands now, with
   * its tick counts; null before planning or once the card's state is gone.
   * Absent on older cached responses. */
  livePlan?: { planMd: string; done: number; total: number } | null;
  runs: Run[];
  events: {
    id: number;
    runId: string | null;
    type: string;
    payload: string;
    createdAt: string;
  }[];
  /** Effective provider+model+reasoning per role — card override for the
   * model, else the global setting; reasoning level is always the current
   * global setting (no per-card override, not persisted per run). `model` is
   * null when that resolves to the provider's subscription default. Absent
   * on older cached responses. */
  models?: {
    planner: { provider: string; model: string | null; reasoningLevel: string };
    loop: { provider: string; model: string | null; reasoningLevel: string };
    evaluator: { provider: string; model: string | null; reasoningLevel: string };
    /** Spec 30: the plan critic. Absent on responses cached before it existed. */
    critic?: { provider: string; model: string | null; reasoningLevel: string };
  };
  /** The card's scoping thread, oldest first. Absent on older cached responses. */
  scoping?: ScopingMessage[];
  /** The scoping turn running right now, if any. Absent on older cached responses. */
  scopingTurn?: ScopingTurn | null;
  /** Spec 24: this card's pieces, in queue order, and the epic it belongs to. */
  children?: ChildCard[];
  parent?: { id: string; title: string; runMode: "ordered" | "parallel" | null } | null;
};

/** Card detail data and card-scoped live refresh. */
export function useCardDetail(cardId: string) {
  const [detail, setDetail] = useState<CardDetailData | null>(null);
  const [error, setError] = useState("");

  const refetch = useCallback(() => {
    api<CardDetailData>(`/api/cards/${cardId}`)
      .then(setDetail)
      .catch((cause) => setError(String(cause)));
  }, [cardId]);
  useEffect(refetch, [refetch]);
  const wasDisconnected = useRef(false);
  useEventStream(
    (event) => {
      if (event.cardId === cardId) refetch();
    },
    (connected) => {
      if (!connected) {
        wasDisconnected.current = true;
        return;
      }
      // Missed events aren't replayed: refetch on a genuine reconnect, not on
      // the first open after mount, which the initial load already covers.
      if (wasDisconnected.current) {
        wasDisconnected.current = false;
        refetch();
      }
    },
  );

  return { detail, error, setError, refetch };
}
