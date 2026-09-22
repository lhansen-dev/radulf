import { eq } from "drizzle-orm";
import { db, settings } from "@/db";
import type { ProviderId } from "./providers";
import { parseRateLimitHeaders, type ProviderRateLimit } from "./harness/rateLimit";
import {
  classifyProviderError,
  parseLimitRetryAfterMs,
  recordProviderOutcome,
  type FailureKind,
} from "./circuitBreaker";

/**
 * Latest rate-limit reading per provider, in the same settings KV table the
 * circuit breaker uses. One row per provider, overwritten on every observation:
 * the history is already in the runs table, and what every consumer wants here
 * is simply "where does this account stand right now".
 */

function key(provider: ProviderId): string {
  return `rateLimit:${provider}`;
}

export function recordProviderRateLimit(reading: ProviderRateLimit): void {
  const value = JSON.stringify(reading);
  db.insert(settings)
    .values({ key: key(reading.provider), value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export function readProviderRateLimit(provider: ProviderId): ProviderRateLimit | null {
  const row = db.select().from(settings).where(eq(settings.key, key(provider))).get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as ProviderRateLimit;
    // Trust the shape only as far as the two fields every consumer reads.
    return parsed && typeof parsed.status === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * When the provider's own reading says the binding window resets, as ms from
 * now: the cooldown a limit failure should actually wait, in preference to
 * any static guess. Null when there is no reading, it is already stale, or the
 * account is not actually out.
 */
export function rateLimitCooldownMs(provider: ProviderId, nowMs = Date.now()): number | null {
  const reading = readProviderRateLimit(provider);
  if (!reading || reading.status !== "exhausted" || !reading.resetAt) return null;
  const resetMs = Date.parse(reading.resetAt);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  return resetMs - nowMs;
}

/**
 * Parse and store one provider response's rate-limit headers.
 *
 * Called from the agent's hot path on every provider response, so it swallows
 * everything: a telemetry write must never be able to fail a run. A provider
 * that sends no such headers (a self-hosted server) records nothing, which
 * readers must read as "unknown", never as "healthy".
 */
export function observeRateLimitHeaders(
  provider: ProviderId,
  headers: Record<string, string> | undefined,
): void {
  try {
    const reading = parseRateLimitHeaders(provider, headers);
    if (reading) recordProviderRateLimit(reading);
  } catch {
    // Intentionally silent, see above.
  }
}

/**
 * How long a limit failure should hold this provider off, in ms.
 *
 * Prefers the account's own observed reset instant (from the response headers
 * of the agent's real traffic) over anything parsed out of the error text: the
 * headers name the window precisely, while an error message may name nothing
 * at all. Falls back to whatever the error itself stated, and finally to null,
 * which leaves the caller on its static per-provider cooldown.
 */
export function limitCooldownMs(
  provider: ProviderId,
  error: string,
  nowMs = Date.now(),
): number | null {
  return rateLimitCooldownMs(provider, nowMs) ?? parseLimitRetryAfterMs(error, nowMs);
}

/**
 * Record a run's harness error against `provider`'s breaker, and say what
 * kind of failure it was (null when it says nothing about the provider).
 *
 * A "config" failure is classified but never recorded: the provider is
 * serving fine and rejecting this request (spec 18 §3), so it must not count
 * towards the breaker. A limit failure carries the cooldown `limitCooldownMs`
 * names. Lives here rather than in circuitBreaker.ts because this module
 * already imports that one; the reverse import would be a cycle.
 */
export function recordProviderFailure(provider: ProviderId, error: string): FailureKind | null {
  const kind = classifyProviderError(error);
  if (kind === null || kind === "config") return kind;
  recordProviderOutcome(provider, false, {
    kind,
    retryAfterMs: kind === "limit" ? limitCooldownMs(provider, error) : null,
  });
  return kind;
}
