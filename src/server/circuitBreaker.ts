import { eq } from "drizzle-orm";
import { db, now, settings } from "@/db";
import type { ProviderId } from "./providers";

// Same connection/auth-shaped failure signal the orchestrator already uses to
// short-circuit a doomed loop run (see orchestrator.ts's connErr check) — the
// one and only classifier for "provider is down", shared rather than
// reinvented here.
export const CONN_ERROR_PATTERN =
  /ECONNREFUSED|connection ?refused|unable to connect|fetch failed|\b401\b|\b403\b|authentication|api key/i;

/**
 * A provider that has run out of allowance, as opposed to one that is down.
 * The distinction matters because the responses differ: a connection failure
 * is worth retrying in a minute, while an exhausted subscription window stays
 * exhausted for hours, and retrying into it just burns the card's failure
 * budget against a provider that cannot answer yet.
 *
 * Deliberately narrow. Transient capacity errors (Anthropic's 529
 * "overloaded") are NOT included: they clear in seconds and a limit-length
 * cooldown would be far too pessimistic for them.
 */
export const LIMIT_ERROR_PATTERN =
  /\b429\b|rate[ _-]?limit|too many requests|usage limit|quota|limit reached|limit exceeded/i;

/** Why a breaker opened. Limits and outages need different cooldowns. */
export type FailureKind = "conn" | "limit";

/**
 * Classify a harness error, or null when it is neither. An unparseable plan
 * or a failing test says nothing about the provider's health. Limit is checked
 * first: a 429 body often also mentions the API key, and the limit reading is
 * the more specific one.
 */
export function classifyProviderError(error: string): FailureKind | null {
  if (LIMIT_ERROR_PATTERN.test(error)) return "limit";
  if (CONN_ERROR_PATTERN.test(error)) return "conn";
  return null;
}

/**
 * How long a limit error says to wait, in ms, or null when it does not say.
 *
 * Handles the two forms that appear verbatim in provider errors: a
 * `retry-after`/"try again in N <unit>" duration, and an ISO-8601 instant for
 * the window reset. Wall-clock phrasings ("resets at 3pm") are deliberately
 * not parsed: they carry no timezone, and guessing one would produce a
 * confidently wrong cooldown rather than an honest default.
 */
export function parseLimitRetryAfterMs(error: string, nowMs = Date.now()): number | null {
  const duration = /(?:retry[- ]after|try again in|retry in)\D{0,10}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)?/i
    .exec(error);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = (duration[2] ?? "s").toLowerCase();
    const scale = unit.startsWith("ms") || unit.startsWith("milli")
      ? 1
      : unit.startsWith("h")
        ? 3_600_000
        : unit.startsWith("m") && !unit.startsWith("ms")
          ? 60_000
          : 1000;
    const ms = amount * scale;
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const instant = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(error);
  if (instant) {
    const resetMs = Date.parse(instant[0]);
    if (Number.isFinite(resetMs) && resetMs > nowMs) return resetMs - nowMs;
  }
  return null;
}

type Thresholds = { failureThreshold: number; cooldownMs: number; limitCooldownMs: number };

// Per-provider trip/retry tuning — cloud subscriptions and a local process
// fail and recover on very different timescales, so one flat threshold either
// trips too eagerly on a local hiccup or too slowly on a cloud outage.
// `satisfies Record<ProviderId, ...>` (rather than a partial map with a
// runtime fallback) means adding a provider to PROVIDERS without an entry
// here is a compile error, not a silent default.
const THRESHOLDS = {
  // Claude subscription login — rate limits/outages are typically
  // minutes-long, so keep the original 3-strikes/60s tuning.
  // A Claude Pro/Max window is measured in hours, not minutes. When the
  // error carries no reset time, wait an hour before probing again rather
  // than re-failing every minute against a window that has not moved.
  anthropic: { failureThreshold: 3, cooldownMs: 60_000, limitCooldownMs: 3_600_000 },
  // ChatGPT/Codex subscription login — same cloud-outage shape as anthropic.
  chatgpt: { failureThreshold: 3, cooldownMs: 60_000, limitCooldownMs: 3_600_000 },
  // GitHub Copilot subscription login — same cloud-outage shape as anthropic.
  copilot: { failureThreshold: 3, cooldownMs: 60_000, limitCooldownMs: 3_600_000 },
  // Local models.json endpoint — a restart/reload resolves in seconds, so
  // trip sooner (avoid burning retries on a process that's mid-restart) and
  // retry sooner (no reason to make callers wait a full cloud-length cooldown).
  // A self-hosted server has no subscription window; a "limit" here is its
  // own concurrency guard, which clears in seconds like its outages do.
  omlx: { failureThreshold: 2, cooldownMs: 15_000, limitCooldownMs: 30_000 },
  // Runtime API key against a cloud aggregator — rate-limit windows are
  // typically >=60s, same tuning as the other cloud providers.
  // Pay-as-you-go credit or a per-key rate window: minutes, not hours.
  openrouter: { failureThreshold: 3, cooldownMs: 60_000, limitCooldownMs: 300_000 },
  // Scripted stand-in — tuned like the cloud providers it simulates.
  mock: { failureThreshold: 3, cooldownMs: 60_000, limitCooldownMs: 60_000 },
} satisfies Record<ProviderId, Thresholds>;

function thresholdsFor(provider: ProviderId): Thresholds {
  return THRESHOLDS[provider];
}

type BreakerState = {
  state: "closed" | "open";
  consecutiveFailures: number;
  openedAt: string | null;
  /** Why it opened, for the UI and for cooldown selection. Null on rows
   * written before limit classification existed, treated as "conn". */
  reason: FailureKind | null;
  /** When the breaker may be probed again. Set explicitly so a reset time
   * parsed out of the provider's own error wins over the static cooldown.
   * Null on older rows, which fall back to openedAt + the cooldown. */
  openUntil: string | null;
};

const CLOSED: BreakerState = {
  state: "closed",
  consecutiveFailures: 0,
  openedAt: null,
  reason: null,
  openUntil: null,
};

function settingsKey(provider: ProviderId): string {
  return `circuitBreaker:${provider}`;
}

function readState(provider: ProviderId): BreakerState {
  const row = db.select().from(settings).where(eq(settings.key, settingsKey(provider))).get();
  if (!row) return CLOSED;
  try {
    const parsed = JSON.parse(row.value) as Partial<BreakerState>;
    return {
      state: parsed.state === "open" ? "open" : "closed",
      consecutiveFailures:
        typeof parsed.consecutiveFailures === "number" ? parsed.consecutiveFailures : 0,
      openedAt: typeof parsed.openedAt === "string" ? parsed.openedAt : null,
      reason: parsed.reason === "limit" || parsed.reason === "conn" ? parsed.reason : null,
      openUntil: typeof parsed.openUntil === "string" ? parsed.openUntil : null,
    };
  } catch {
    return CLOSED;
  }
}

function writeState(provider: ProviderId, state: BreakerState): void {
  db.insert(settings)
    .values({ key: settingsKey(provider), value: JSON.stringify(state) })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(state) } })
    .run();
}

/**
 * Record the outcome of a plan/loop/evaluate run for `provider` — a
 * connection/auth-shaped failure (per CONN_ERROR_PATTERN), or a clean
 * completion. A success always closes the breaker. Consecutive failures trip
 * it open once `provider`'s failureThreshold (see THRESHOLDS) is reached; a
 * failure while already open (including a cooled-down half-open probe, see
 * isProviderOpen) re-opens it immediately rather than waiting for another
 * failureThreshold strikes.
 */
export function recordProviderOutcome(
  provider: ProviderId,
  ok: boolean,
  failure?: { kind: FailureKind; retryAfterMs?: number | null },
): void {
  if (ok) {
    writeState(provider, CLOSED);
    return;
  }
  const current = readState(provider);
  const consecutiveFailures = current.consecutiveFailures + 1;
  const kind = failure?.kind ?? "conn";
  const thresholds = thresholdsFor(provider);
  // A limit error is a statement of fact, not a flake: the allowance is gone
  // and the next call will hit the same wall, so open on the first one rather
  // than spending two more runs proving it.
  const open =
    kind === "limit" ||
    current.state === "open" ||
    consecutiveFailures >= thresholds.failureThreshold;
  const cooldownMs =
    failure?.retryAfterMs && failure.retryAfterMs > 0
      ? failure.retryAfterMs
      : kind === "limit"
        ? thresholds.limitCooldownMs
        : thresholds.cooldownMs;
  const openedAtMs = Date.now();
  writeState(provider, {
    state: open ? "open" : "closed",
    consecutiveFailures,
    openedAt: open ? now() : null,
    reason: open ? kind : null,
    openUntil: open ? new Date(openedAtMs + cooldownMs).toISOString() : null,
  });
}

/**
 * True when `provider`'s breaker is open and its cooldown hasn't elapsed —
 * callers should fail fast rather than start a run. Once the cooldown
 * passes this returns false (half-open: exactly one probe run is let
 * through), and that run's outcome decides the next state via
 * recordProviderOutcome.
 */
export function isProviderOpen(provider: ProviderId): boolean {
  const until = providerOpenUntilMs(provider);
  return until !== null && Date.now() < until;
}

/**
 * When `provider`'s breaker may next be probed, in epoch ms, or null when it
 * is closed. Prefers the stored `openUntil` (which may carry a reset time the
 * provider itself named) and falls back to openedAt + the static cooldown for
 * rows written before that field existed.
 */
function providerOpenUntilMs(provider: ProviderId): number | null {
  const current = readState(provider);
  if (current.state !== "open") return null;
  if (current.openUntil) {
    const untilMs = Date.parse(current.openUntil);
    if (Number.isFinite(untilMs)) return untilMs;
  }
  if (!current.openedAt) return null;
  const openedAtMs = Date.parse(current.openedAt);
  if (!Number.isFinite(openedAtMs)) return null;
  const thresholds = thresholdsFor(provider);
  return openedAtMs + (current.reason === "limit" ? thresholds.limitCooldownMs : thresholds.cooldownMs);
}

/** Breaker state for one provider, for the providers health panel. */
export type ProviderBreakerStatus = {
  provider: ProviderId;
  state: "closed" | "open";
  reason: FailureKind | null;
  consecutiveFailures: number;
  openedAt: string | null;
  /** ISO instant the breaker may next be probed, when open. */
  openUntil: string | null;
};

export function providerBreakerStatus(provider: ProviderId): ProviderBreakerStatus {
  const current = readState(provider);
  const untilMs = providerOpenUntilMs(provider);
  const open = untilMs !== null && Date.now() < untilMs;
  return {
    provider,
    // A cooled-down breaker is reported closed: the next run is the half-open
    // probe, and showing it as open would misread as "still blocked".
    state: open ? "open" : "closed",
    reason: open ? current.reason : null,
    consecutiveFailures: current.consecutiveFailures,
    openedAt: open ? current.openedAt : null,
    openUntil: open && untilMs !== null ? new Date(untilMs).toISOString() : null,
  };
}
