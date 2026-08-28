import { eq } from "drizzle-orm";
import { db, now, settings } from "@/db";
import type { ProviderId } from "./providers";

// Same connection/auth-shaped failure signal the orchestrator already uses to
// short-circuit a doomed loop run (see orchestrator.ts's connErr check) — the
// one and only classifier for "provider is down", shared rather than
// reinvented here.
export const CONN_ERROR_PATTERN =
  /ECONNREFUSED|connection ?refused|unable to connect|fetch failed|\b401\b|\b403\b|authentication|api key/i;

type Thresholds = { failureThreshold: number; cooldownMs: number };

// Per-provider trip/retry tuning — cloud subscriptions and a local process
// fail and recover on very different timescales, so one flat threshold either
// trips too eagerly on a local hiccup or too slowly on a cloud outage.
// `satisfies Record<ProviderId, ...>` (rather than a partial map with a
// runtime fallback) means adding a provider to PROVIDERS without an entry
// here is a compile error, not a silent default.
const THRESHOLDS = {
  // Claude subscription login — rate limits/outages are typically
  // minutes-long, so keep the original 3-strikes/60s tuning.
  anthropic: { failureThreshold: 3, cooldownMs: 60_000 },
  // ChatGPT/Codex subscription login — same cloud-outage shape as anthropic.
  chatgpt: { failureThreshold: 3, cooldownMs: 60_000 },
  // GitHub Copilot subscription login — same cloud-outage shape as anthropic.
  copilot: { failureThreshold: 3, cooldownMs: 60_000 },
  // Local models.json endpoint — a restart/reload resolves in seconds, so
  // trip sooner (avoid burning retries on a process that's mid-restart) and
  // retry sooner (no reason to make callers wait a full cloud-length cooldown).
  omlx: { failureThreshold: 2, cooldownMs: 15_000 },
  // Runtime API key against a cloud aggregator — rate-limit windows are
  // typically >=60s, same tuning as the other cloud providers.
  openrouter: { failureThreshold: 3, cooldownMs: 60_000 },
} satisfies Record<ProviderId, Thresholds>;

function thresholdsFor(provider: ProviderId): Thresholds {
  return THRESHOLDS[provider];
}

type BreakerState = {
  state: "closed" | "open";
  consecutiveFailures: number;
  openedAt: string | null;
};

const CLOSED: BreakerState = { state: "closed", consecutiveFailures: 0, openedAt: null };

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
export function recordProviderOutcome(provider: ProviderId, ok: boolean): void {
  if (ok) {
    writeState(provider, CLOSED);
    return;
  }
  const current = readState(provider);
  const consecutiveFailures = current.consecutiveFailures + 1;
  const open =
    current.state === "open" || consecutiveFailures >= thresholdsFor(provider).failureThreshold;
  writeState(provider, {
    state: open ? "open" : "closed",
    consecutiveFailures,
    openedAt: open ? now() : null,
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
  const current = readState(provider);
  if (current.state !== "open" || !current.openedAt) return false;
  const openedAtMs = Date.parse(current.openedAt);
  if (!Number.isFinite(openedAtMs)) return false;
  return Date.now() - openedAtMs < thresholdsFor(provider).cooldownMs;
}
