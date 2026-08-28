"use client";

import { useCallback, useEffect, useState } from "react";
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
  useEventStream((event) => {
    if (event.cardId === cardId) refetch();
  });

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
