import type { ProviderId } from "../providers";

/**
 * Provider rate-limit telemetry, read from the response headers of the agent's
 * own requests.
 *
 * This is the only first-party source of remaining allowance available to
 * Radulf. pi exposes no quota API, and the subscription providers publish no
 * endpoint for it — but they do stamp every response with where the account
 * stands, and pi surfaces those headers through the `after_provider_response`
 * extension event. Reading them costs nothing extra: they arrive on requests
 * the agent was making anyway, and they are scoped to the credential Radulf
 * itself is using rather than to whatever is logged in elsewhere on the box.
 */

export type RateLimitStatus = "ok" | "warning" | "exhausted";

export type RateLimitWindow = {
  /** The provider's own name for the window, e.g. "5h", "7d", "requests". */
  label: string;
  /** Fraction of the window consumed, 0..1, when the provider reports one. */
  utilization: number | null;
  /** Units left, when the provider reports counts rather than a fraction. */
  remaining: number | null;
  status: RateLimitStatus | null;
  /** ISO instant the window resets. */
  resetAt: string | null;
};

export type ProviderRateLimit = {
  provider: ProviderId;
  observedAt: string;
  status: RateLimitStatus;
  windows: RateLimitWindow[];
  /** Label of the window the provider says is currently binding, when it says. */
  bindingWindow: string | null;
  /** When the binding window resets. */
  resetAt: string | null;
  /** False when the plan has no paid overflow past the limit, so reaching it
   * is a hard stop rather than a spillover. Null when the provider is silent. */
  overageAvailable: boolean | null;
};

/** Headers arrive lowercased from pi, but never assume it. */
function get(headers: Record<string, string>, name: string): string | undefined {
  return headers[name] ?? headers[name.toLowerCase()];
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Epoch seconds (what Anthropic sends) or milliseconds, as an ISO instant.
 * Values below 1e11 are seconds — that boundary is the year 5138 in seconds
 * and 1973 in milliseconds, so no real timestamp is ambiguous.
 */
function epochToIso(value: number | null): string | null {
  if (value === null || value <= 0) return null;
  const ms = value < 1e11 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Anthropic's unified status vocabulary, narrowed to ours. */
function anthropicStatus(raw: string | undefined): RateLimitStatus | null {
  if (!raw) return null;
  if (raw === "allowed") return "ok";
  if (raw === "allowed_warning") return "warning";
  // "rejected", "blocked", and anything unrecognized are treated as spent:
  // guessing optimistically about an unknown status would send a card into a
  // provider that just said no.
  return "exhausted";
}

function anthropicRateLimit(
  provider: ProviderId,
  headers: Record<string, string>,
  observedAt: string,
): ProviderRateLimit | null {
  const overall = get(headers, "anthropic-ratelimit-unified-status");
  if (!overall) return null;

  const windows: RateLimitWindow[] = [];
  for (const label of ["5h", "7d"]) {
    const utilization = num(get(headers, `anthropic-ratelimit-unified-${label}-utilization`));
    const status = anthropicStatus(get(headers, `anthropic-ratelimit-unified-${label}-status`));
    const resetAt = epochToIso(num(get(headers, `anthropic-ratelimit-unified-${label}-reset`)));
    if (utilization === null && status === null && resetAt === null) continue;
    windows.push({ label, utilization, remaining: null, status, resetAt });
  }

  // "seven_day" / "five_hour" name the window that is currently binding.
  const claim = get(headers, "anthropic-ratelimit-unified-representative-claim");
  const bindingWindow =
    claim === "seven_day" ? "7d" : claim === "five_hour" ? "5h" : null;

  const overageStatus = get(headers, "anthropic-ratelimit-unified-overage-status");

  return {
    provider,
    observedAt,
    status: anthropicStatus(overall) ?? "ok",
    windows,
    bindingWindow,
    resetAt: epochToIso(num(get(headers, "anthropic-ratelimit-unified-reset"))),
    overageAvailable: overageStatus === undefined ? null : overageStatus === "allowed",
  };
}

/**
 * The `x-ratelimit-*` convention shared by OpenAI-compatible endpoints and
 * OpenRouter: counts rather than fractions, so utilization is derived from
 * limit and remaining when both are present.
 */
function xRateLimit(
  provider: ProviderId,
  headers: Record<string, string>,
  observedAt: string,
): ProviderRateLimit | null {
  const windows: RateLimitWindow[] = [];
  for (const label of ["requests", "tokens"]) {
    const remaining = num(get(headers, `x-ratelimit-remaining-${label}`));
    const limit = num(get(headers, `x-ratelimit-limit-${label}`));
    if (remaining === null && limit === null) continue;
    const utilization =
      remaining !== null && limit !== null && limit > 0
        ? Math.min(1, Math.max(0, 1 - remaining / limit))
        : null;
    windows.push({
      label,
      utilization,
      remaining,
      // A count of zero left is the same fact Anthropic states as "rejected".
      status: remaining === null ? null : remaining <= 0 ? "exhausted" : "ok",
      resetAt: epochToIso(num(get(headers, `x-ratelimit-reset-${label}`))),
    });
  }
  if (windows.length === 0) return null;

  // The whole provider is as spent as its most-spent window.
  const status: RateLimitStatus = windows.some((w) => w.status === "exhausted")
    ? "exhausted"
    : windows.some((w) => (w.utilization ?? 0) >= 0.9)
      ? "warning"
      : "ok";
  const binding = windows.find((w) => w.status === "exhausted") ?? windows[0];

  return {
    provider,
    observedAt,
    status,
    windows,
    bindingWindow: binding.label,
    resetAt: binding.resetAt,
    overageAvailable: null,
  };
}

/**
 * Normalize one provider response's rate-limit headers, or null when the
 * provider sends none — a self-hosted server usually does, and a missing
 * reading must never be confused with a healthy one.
 */
export function parseRateLimitHeaders(
  provider: ProviderId,
  headers: Record<string, string> | undefined,
  observedAtMs: number = Date.now(),
): ProviderRateLimit | null {
  if (!headers) return null;
  const observedAt = new Date(observedAtMs).toISOString();
  return (
    anthropicRateLimit(provider, headers, observedAt) ??
    xRateLimit(provider, headers, observedAt)
  );
}
