import { describe, expect, it } from "vitest";
import { parseRateLimitHeaders } from "./rateLimit";

/**
 * Captured verbatim from a live Claude subscription (OAuth) response on
 * 2026-09-20 — the headers the docs describe for API keys are NOT what the
 * subscription path sends, so this fixture is the record of what it really is.
 */
const ANTHROPIC_SUBSCRIPTION_HEADERS: Record<string, string> = {
  "anthropic-organization-id": "org-x",
  "anthropic-ratelimit-unified-5h-reset": "1789944000",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.05",
  "anthropic-ratelimit-unified-7d-reset": "1790236800",
  "anthropic-ratelimit-unified-7d-status": "allowed_warning",
  "anthropic-ratelimit-unified-7d-surpassed-threshold": "0.75",
  "anthropic-ratelimit-unified-7d-utilization": "0.8",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "seven_day",
  "anthropic-ratelimit-unified-reset": "1790236800",
  "anthropic-ratelimit-unified-status": "allowed_warning",
  "content-type": "application/json",
};

const OBSERVED_AT_MS = Date.parse("2026-09-20T15:51:05.000Z");

describe("parseRateLimitHeaders — Anthropic subscription", () => {
  it("reads both windows, the binding one, and the overage stance", () => {
    const reading = parseRateLimitHeaders("anthropic", ANTHROPIC_SUBSCRIPTION_HEADERS, OBSERVED_AT_MS)!;
    expect(reading.status).toBe("warning");
    expect(reading.bindingWindow).toBe("7d");
    expect(reading.resetAt).toBe("2026-09-24T08:00:00.000Z");
    // No paid overflow: reaching the limit is a hard stop, not a spillover.
    expect(reading.overageAvailable).toBe(false);
    expect(reading.windows).toEqual([
      { label: "5h", utilization: 0.05, remaining: null, status: "ok", resetAt: "2026-09-20T22:40:00.000Z" },
      { label: "7d", utilization: 0.8, remaining: null, status: "warning", resetAt: "2026-09-24T08:00:00.000Z" },
    ]);
  });

  it("treats a refusal, and any status it does not recognize, as spent", () => {
    for (const status of ["rejected", "blocked", "something_new"]) {
      const reading = parseRateLimitHeaders(
        "anthropic",
        { ...ANTHROPIC_SUBSCRIPTION_HEADERS, "anthropic-ratelimit-unified-status": status },
        OBSERVED_AT_MS,
      )!;
      expect(reading.status).toBe("exhausted");
    }
  });

  it("keeps a window that reports only some of its fields", () => {
    const reading = parseRateLimitHeaders("anthropic", {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.4",
    }, OBSERVED_AT_MS)!;
    expect(reading.windows).toEqual([
      { label: "5h", utilization: 0.4, remaining: null, status: null, resetAt: null },
    ]);
    expect(reading.bindingWindow).toBeNull();
    // Silence about overage is not the same as overage being unavailable.
    expect(reading.overageAvailable).toBeNull();
  });

  it("ignores an unparseable timestamp rather than inventing one", () => {
    const reading = parseRateLimitHeaders("anthropic", {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": "not-a-number",
    }, OBSERVED_AT_MS)!;
    expect(reading.resetAt).toBeNull();
  });
});

describe("parseRateLimitHeaders — x-ratelimit providers", () => {
  it("derives utilization from limit and remaining", () => {
    const reading = parseRateLimitHeaders("openrouter", {
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "250",
      "x-ratelimit-reset-requests": "1790236800",
    }, OBSERVED_AT_MS)!;
    expect(reading.windows[0]).toEqual({
      label: "requests", utilization: 0.75, remaining: 250, status: "ok",
      resetAt: "2026-09-24T08:00:00.000Z",
    });
    expect(reading.status).toBe("ok");
  });

  it("calls the provider spent when any window has nothing left", () => {
    const reading = parseRateLimitHeaders("openrouter", {
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "500",
      "x-ratelimit-limit-tokens": "100",
      "x-ratelimit-remaining-tokens": "0",
    }, OBSERVED_AT_MS)!;
    expect(reading.status).toBe("exhausted");
    expect(reading.bindingWindow).toBe("tokens");
  });

  it("warns once a window is nearly gone", () => {
    const reading = parseRateLimitHeaders("openrouter", {
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "50",
    }, OBSERVED_AT_MS)!;
    expect(reading.status).toBe("warning");
  });
});

describe("parseRateLimitHeaders — absence", () => {
  it("returns null when the provider reports nothing, so callers read unknown rather than healthy", () => {
    expect(parseRateLimitHeaders("omlx", { "content-type": "application/json" }, OBSERVED_AT_MS)).toBeNull();
    expect(parseRateLimitHeaders("omlx", {}, OBSERVED_AT_MS)).toBeNull();
    expect(parseRateLimitHeaders("omlx", undefined, OBSERVED_AT_MS)).toBeNull();
  });

  it("accepts epoch milliseconds as well as seconds", () => {
    const seconds = parseRateLimitHeaders("anthropic", {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": "1790236800",
    }, OBSERVED_AT_MS)!;
    const millis = parseRateLimitHeaders("anthropic", {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": "1790236800000",
    }, OBSERVED_AT_MS)!;
    expect(seconds.resetAt).toBe(millis.resetAt);
  });
});
