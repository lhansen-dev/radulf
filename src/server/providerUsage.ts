import type { ProviderBreakerStatus } from "./circuitBreaker";
import type { ProviderRateLimit } from "./harness/rateLimit";
import { PROVIDERS, type ProviderId } from "./providers";

/**
 * Per-provider usage and health.
 *
 * There is no quota endpoint to poll: pi exposes per-turn token usage but
 * nothing about a subscription's remaining allowance, and the OAuth
 * subscriptions do not publish one through this harness. So "how much have we
 * used" is answered from Radulf's own run history, and "are we out" is
 * answered by the circuit breaker's record of what the provider actually said.
 * Both are honest about being observations rather than a quota reading.
 */

export type ProviderUsageRun = {
  provider?: string | null;
  status: string;
  startedAt: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costUsd?: number | null;
};

export type ProviderUsageRow = {
  provider: ProviderId;
  /** Runs started inside the window. */
  runs: number;
  failedRuns: number;
  promptTokens: number;
  completionTokens: number;
  /** Summed only over runs that reported a cost; a subscription reports none. */
  costUsd: number;
  /** True when at least one run in the window reported a cost, so the UI can
   * tell "no spend" apart from "flat-rate, no meter". */
  costReported: boolean;
  lastRunAt: string | null;
  breaker: ProviderBreakerStatus;
  /** Latest reading from the provider's own response headers, or null when it
   * sends none. Null means unknown, never healthy. */
  rateLimit: ProviderRateLimit | null;
};

export const USAGE_WINDOW_HOURS = 24;

/** Sum a nullable telemetry column, treating unreported as absent, not zero. */
function add(total: number, value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? total + value : total;
}

/**
 * Roll `runs` up per provider over the trailing window. Providers with no runs
 * in the window are still returned, so the panel lists every configured
 * provider rather than only the busy ones.
 */
export function computeProviderUsage(input: {
  runs: readonly ProviderUsageRun[];
  breakers: readonly ProviderBreakerStatus[];
  rateLimits?: readonly ProviderRateLimit[];
  nowMs: number;
  windowHours?: number;
}): ProviderUsageRow[] {
  const windowHours = input.windowHours ?? USAGE_WINDOW_HOURS;
  const cutoffMs = input.nowMs - windowHours * 3_600_000;
  const byProvider = new Map(input.breakers.map((breaker) => [breaker.provider, breaker]));
  const limitsByProvider = new Map((input.rateLimits ?? []).map((r) => [r.provider, r]));

  return PROVIDERS.map(({ id }) => {
    const breaker = byProvider.get(id) ?? {
      provider: id,
      state: "closed" as const,
      reason: null,
      consecutiveFailures: 0,
      openedAt: null,
      openUntil: null,
    };
    const row: ProviderUsageRow = {
      provider: id,
      runs: 0,
      failedRuns: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      costReported: false,
      lastRunAt: null,
      breaker,
      rateLimit: limitsByProvider.get(id) ?? null,
    };
    for (const run of input.runs) {
      if (run.provider !== id) continue;
      const startedMs = Date.parse(run.startedAt);
      if (!Number.isFinite(startedMs) || startedMs < cutoffMs) continue;
      row.runs += 1;
      if (run.status === "failed" || run.status === "timeout") row.failedRuns += 1;
      row.promptTokens = add(row.promptTokens, run.promptTokens);
      row.completionTokens = add(row.completionTokens, run.completionTokens);
      if (typeof run.costUsd === "number" && Number.isFinite(run.costUsd)) {
        row.costUsd += run.costUsd;
        row.costReported = true;
      }
      if (!row.lastRunAt || run.startedAt > row.lastRunAt) row.lastRunAt = run.startedAt;
    }
    return row;
  });
}
