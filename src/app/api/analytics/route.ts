import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db, cards, runs, iterations } from "@/db";
import { computeAnalytics } from "@/server/analytics";
import type { AnalyticsResponse } from "@/server/analytics";
import { json } from "../_lib";

const MAX_ANALYTICS_RUNS = 5_000;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const range = searchParams.get("range");
  const provider = searchParams.get("provider") ?? "";
  const model = searchParams.get("model") ?? "";

  function fromMsForRange(range: string | null): number | null {
    switch (range) {
      case "today":
        return new Date().setHours(0, 0, 0, 0);
      case "7d":
        return Date.now() - 7 * 86400000;
      case "30d":
        return Date.now() - 30 * 86400000;
      default:
        return null;
    }
  }

  const allCards = db
    .select({ id: cards.id, title: cards.title, status: cards.status })
    .from(cards)
    .all();

  // startedAt is ISO text, so an ISO lower bound compares correctly in SQL.
  const fromMs = fromMsForRange(range);
  const filteredRuns = db
    .select({
      id: runs.id,
      cardId: runs.cardId,
      kind: runs.kind,
      status: runs.status,
      iterationsDone: runs.iterationsDone,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      provider: runs.provider,
      model: runs.model,
      promptTokens: runs.promptTokens,
      completionTokens: runs.completionTokens,
      costUsd: runs.costUsd,
    })
    .from(runs)
    .where(
      and(
        fromMs == null ? undefined : gte(runs.startedAt, new Date(fromMs).toISOString()),
        provider ? eq(runs.provider, provider) : undefined,
        model ? eq(runs.model, model) : undefined,
      ),
    )
    .orderBy(desc(runs.startedAt))
    .limit(MAX_ANALYTICS_RUNS)
    .all();

  const runIds = filteredRuns.map((run) => run.id);
  const allIterations = runIds.length === 0
    ? []
    : db.select({
      id: iterations.id,
      runId: iterations.runId,
      n: iterations.n,
      promptTokens: iterations.promptTokens,
      completionTokens: iterations.completionTokens,
      cachedInputTokens: iterations.cachedInputTokens,
      cacheWriteTokens: iterations.cacheWriteTokens,
      reasoningTokens: iterations.reasoningTokens,
      modelTurns: iterations.modelTurns,
      toolCalls: iterations.toolCalls,
      toolDurationMs: iterations.toolDurationMs,
      costUsd: iterations.costUsd,
      actualProvider: iterations.actualProvider,
      actualModel: iterations.actualModel,
      harness: iterations.harness,
      harnessVersion: iterations.harnessVersion,
      startedAt: iterations.startedAt,
      endedAt: iterations.endedAt,
    })
    .from(iterations)
    .where(inArray(iterations.runId, runIds))
    .all();

  const result = computeAnalytics({ cards: allCards, runs: filteredRuns, iterations: allIterations });

  // Distinct sorted non-empty labels from ALL runs for dropdown options
  const pairs = db.selectDistinct({ provider: runs.provider, model: runs.model }).from(runs).all();
  const providers = [...new Set(pairs.map((r) => r.provider).filter((p): p is string => !!p))].sort();
  const models = [...new Set(pairs.map((r) => r.model).filter((m): m is string => !!m))].sort();

  const response: AnalyticsResponse = { ...result, providers, models };

  return json(response);
}
