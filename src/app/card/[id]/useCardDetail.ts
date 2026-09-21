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
    autoApprove: number;
    summary: string | null;
    startedAt: string | null;
    createdAt: string;
    baseBranch: string | null;
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
  };
  /** The card's scoping thread, oldest first. Absent on older cached responses. */
  scoping?: ScopingMessage[];
};

type ModelOption = { value: string; displayName: string };

/** Card detail data, provider model options, and card-scoped live refresh. */
export function useCardDetail(cardId: string) {
  const [detail, setDetail] = useState<CardDetailData | null>(null);
  const [error, setError] = useState("");
  const [plannerModels, setPlannerModels] = useState<ModelOption[]>([]);
  const [loopModels, setLoopModels] = useState<ModelOption[]>([]);
  const [evaluatorModels, setEvaluatorModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    api<{
      plannerProvider: string;
      loopProvider: string;
      evaluatorProvider: string;
    }>("/api/settings")
      .then(async (settings) => {
        const loadModels = (provider: string) =>
          api<{ models: ModelOption[] }>(`/api/providers/${provider}/models`)
            .catch(() => ({ models: [] }));
        const [planner, loop, evaluator] = await Promise.all([
          loadModels(settings.plannerProvider),
          loadModels(settings.loopProvider),
          loadModels(settings.evaluatorProvider),
        ]);
        setPlannerModels(planner.models);
        setLoopModels(loop.models);
        setEvaluatorModels(evaluator.models);
      })
      .catch(() => {});
  }, []);

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

  return {
    detail,
    error,
    setError,
    plannerModels,
    loopModels,
    evaluatorModels,
    refetch,
  };
}
