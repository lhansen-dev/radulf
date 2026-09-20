import { describe, expect, it } from "vitest";
import { computeProviderUsage } from "./providerUsage";
import type { ProviderBreakerStatus } from "./circuitBreaker";
import type { ProviderRateLimit } from "./harness/rateLimit";

const closed = (provider: ProviderBreakerStatus["provider"]): ProviderBreakerStatus => ({
  provider, state: "closed", reason: null, consecutiveFailures: 0, openedAt: null, openUntil: null,
});

const nowMs = Date.parse("2026-09-20T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(nowMs - hoursAgo * 3_600_000).toISOString();

describe("computeProviderUsage", () => {
  it("rolls tokens and failures up per provider inside the window", () => {
    const rows = computeProviderUsage({
      nowMs,
      windowHours: 24,
      breakers: [closed("omlx"), closed("anthropic")],
      runs: [
        { provider: "omlx", status: "completed", startedAt: at(1), promptTokens: 1000, completionTokens: 50 },
        { provider: "omlx", status: "failed", startedAt: at(2), promptTokens: 500, completionTokens: 10 },
        { provider: "omlx", status: "timeout", startedAt: at(3), promptTokens: 200, completionTokens: null },
        { provider: "anthropic", status: "completed", startedAt: at(1), promptTokens: 80, completionTokens: 20, costUsd: 0.5 },
      ],
    });
    const omlx = rows.find((r) => r.provider === "omlx")!;
    expect(omlx.runs).toBe(3);
    expect(omlx.failedRuns).toBe(2);
    expect(omlx.promptTokens).toBe(1700);
    // A null completion count is unreported, never coerced to zero into the sum.
    expect(omlx.completionTokens).toBe(60);
    // A self-hosted endpoint reports no cost, so the panel can say so.
    expect(omlx.costReported).toBe(false);
    expect(rows.find((r) => r.provider === "anthropic")!.costReported).toBe(true);
  });

  it("excludes runs older than the window", () => {
    const rows = computeProviderUsage({
      nowMs,
      windowHours: 24,
      breakers: [closed("omlx")],
      runs: [
        { provider: "omlx", status: "completed", startedAt: at(23), promptTokens: 1 },
        { provider: "omlx", status: "completed", startedAt: at(25), promptTokens: 999 },
      ],
    });
    const omlx = rows.find((r) => r.provider === "omlx")!;
    expect(omlx.runs).toBe(1);
    expect(omlx.promptTokens).toBe(1);
  });

  it("attaches a rate-limit reading to its provider and leaves the rest unknown", () => {
    const reading: ProviderRateLimit = {
      provider: "anthropic", observedAt: at(0.1), status: "warning",
      windows: [{ label: "7d", utilization: 0.8, remaining: null, status: "warning", resetAt: at(-85) }],
      bindingWindow: "7d", resetAt: at(-85), overageAvailable: false,
    };
    const rows = computeProviderUsage({
      nowMs, windowHours: 24, breakers: [closed("anthropic"), closed("omlx")],
      rateLimits: [reading], runs: [],
    });
    expect(rows.find((r) => r.provider === "anthropic")!.rateLimit).toEqual(reading);
    // A provider that reports no headers stays null, which readers must treat
    // as unknown rather than as healthy.
    expect(rows.find((r) => r.provider === "omlx")!.rateLimit).toBeNull();
  });

  it("returns every provider, and carries the breaker state through", () => {
    const openBreaker: ProviderBreakerStatus = {
      provider: "anthropic", state: "open", reason: "limit", consecutiveFailures: 1,
      openedAt: at(0.5), openUntil: new Date(nowMs + 1_800_000).toISOString(),
    };
    const rows = computeProviderUsage({ nowMs, windowHours: 24, breakers: [openBreaker], runs: [] });
    expect(rows.map((r) => r.provider)).toContain("copilot");
    const anthropic = rows.find((r) => r.provider === "anthropic")!;
    expect(anthropic.runs).toBe(0);
    expect(anthropic.breaker.reason).toBe("limit");
    // A provider with no runs still defaults to a closed breaker, not a crash.
    expect(rows.find((r) => r.provider === "omlx")!.breaker.state).toBe("closed");
  });
});
