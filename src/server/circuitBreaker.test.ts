import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-circuit-breaker-"));
process.env.RADULF_DATA_DIR = testDataDir;

const { db, settings } = await import("@/db");
const {
  recordProviderOutcome,
  isProviderOpen,
  CONN_ERROR_PATTERN,
  LIMIT_ERROR_PATTERN,
  classifyProviderError,
  isRetryableFailure,
  parseLimitRetryAfterMs,
  providerBreakerStatus,
} = await import("./circuitBreaker");

afterAll(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.RADULF_DATA_DIR;
});

beforeEach(() => {
  db.delete(settings).run();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CONN_ERROR_PATTERN", () => {
  it("matches connection/auth-shaped errors only", () => {
    for (const e of ["fetch failed", "401 Unauthorized", "ECONNREFUSED"]) {
      expect(CONN_ERROR_PATTERN.test(e)).toBe(true);
    }
    expect(CONN_ERROR_PATTERN.test("plan checklist unparseable")).toBe(false);
  });
});

describe("LIMIT_ERROR_PATTERN", () => {
  it("matches allowance-shaped errors", () => {
    for (const e of [
      "429 Too Many Requests",
      "rate_limit_error",
      "You have reached your usage limit for this window",
      "quota exceeded",
    ]) {
      expect(LIMIT_ERROR_PATTERN.test(e)).toBe(true);
    }
  });

  it("leaves transient capacity errors alone, since they clear in seconds", () => {
    expect(LIMIT_ERROR_PATTERN.test("529 overloaded_error")).toBe(false);
    expect(LIMIT_ERROR_PATTERN.test("plan checklist unparseable")).toBe(false);
  });
});

describe("classifyProviderError", () => {
  it("reads a limit before an auth phrase in the same body", () => {
    expect(classifyProviderError("429 rate limit, check your api key")).toBe("limit");
  });

  it("still reads plain connection failures as conn", () => {
    expect(classifyProviderError("ECONNREFUSED")).toBe("conn");
  });

  it("returns null for failures that say nothing about the provider", () => {
    expect(classifyProviderError("2 tests failed")).toBeNull();
  });

  it("reads a rejected request as config", () => {
    // Verbatim from the planner run that failed this way three times.
    expect(
      classifyProviderError(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
          '"Claude Code 2.1.75 does not support this model; version 2.1.251 or newer is required"}}',
      ),
    ).toBe("config");
  });

  it("keeps the more specific reading when a rejected request also smells of auth or limits", () => {
    expect(classifyProviderError("400 invalid_request: bad api key")).toBe("conn");
    expect(classifyProviderError("429 model_not_found while rate limited")).toBe("limit");
  });

  it("knows a config failure is the one kind no retry can help", () => {
    expect(isRetryableFailure("config")).toBe(false);
    expect(isRetryableFailure("conn")).toBe(true);
    expect(isRetryableFailure("limit")).toBe(true);
    expect(isRetryableFailure(null)).toBe(true);
  });
});

describe("parseLimitRetryAfterMs", () => {
  it("reads a retry-after duration with its unit", () => {
    expect(parseLimitRetryAfterMs("rate limited; retry after 30 seconds")).toBe(30_000);
    expect(parseLimitRetryAfterMs("try again in 5 minutes")).toBe(300_000);
    expect(parseLimitRetryAfterMs("retry-after: 2h")).toBe(7_200_000);
  });

  it("reads an ISO reset instant as a delay from now", () => {
    const nowMs = Date.parse("2026-09-20T12:00:00.000Z");
    expect(parseLimitRetryAfterMs("resets at 2026-09-20T13:00:00Z", nowMs)).toBe(3_600_000);
  });

  it("returns null rather than guessing at a wall-clock phrasing", () => {
    expect(parseLimitRetryAfterMs("your limit resets at 3pm")).toBeNull();
    expect(parseLimitRetryAfterMs("429 Too Many Requests")).toBeNull();
  });
});

describe("limit errors", () => {
  it("opens the breaker on the first one, without spending the failure budget", () => {
    recordProviderOutcome("anthropic", false, { kind: "limit" });
    expect(isProviderOpen("anthropic")).toBe(true);
    expect(providerBreakerStatus("anthropic").reason).toBe("limit");
  });

  it("holds a limit far longer than a connection blip", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    recordProviderOutcome("anthropic", false, { kind: "limit" });
    // The 60s connection cooldown would have expired by now; the limit one has not.
    vi.setSystemTime(new Date("2026-09-20T12:05:00.000Z"));
    expect(isProviderOpen("anthropic")).toBe(true);
    vi.setSystemTime(new Date("2026-09-20T13:01:00.000Z"));
    expect(isProviderOpen("anthropic")).toBe(false);
  });

  it("prefers a reset time the provider named over the default cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    recordProviderOutcome("anthropic", false, { kind: "limit", retryAfterMs: 120_000 });
    expect(providerBreakerStatus("anthropic").openUntil).toBe("2026-09-20T12:02:00.000Z");
    vi.setSystemTime(new Date("2026-09-20T12:02:01.000Z"));
    expect(isProviderOpen("anthropic")).toBe(false);
  });

  it("clears on the next success", () => {
    recordProviderOutcome("anthropic", false, { kind: "limit" });
    recordProviderOutcome("anthropic", true);
    expect(isProviderOpen("anthropic")).toBe(false);
    expect(providerBreakerStatus("anthropic").reason).toBeNull();
  });
});

describe("circuit breaker state machine", () => {
  const fail = (provider: Parameters<typeof recordProviderOutcome>[0], times: number) => {
    for (let i = 0; i < times; i++) recordProviderOutcome(provider, false);
  };

  it("opens on a per-provider consecutive-failure threshold, tracking providers independently", () => {
    // omlx's threshold (2) is lower than anthropic's (3): a local process is
    // expected to fail and recover fast, so it trips sooner.
    expect(isProviderOpen("anthropic")).toBe(false);
    fail("anthropic", 2);
    fail("omlx", 2);
    expect(isProviderOpen("anthropic")).toBe(false);
    expect(isProviderOpen("omlx")).toBe(true);

    fail("anthropic", 1);
    expect(isProviderOpen("anthropic")).toBe(true);
    expect(isProviderOpen("openrouter")).toBe(false);
  });

  it("goes half-open after a per-provider cooldown: omlx's 15s elapses before anthropic's 60s", () => {
    vi.useFakeTimers();
    fail("omlx", 2);
    fail("anthropic", 3);

    vi.advanceTimersByTime(16_000);
    expect(isProviderOpen("omlx")).toBe(false);
    expect(isProviderOpen("anthropic")).toBe(true);

    vi.advanceTimersByTime(45_000);
    expect(isProviderOpen("anthropic")).toBe(false);
  });

  it("closes fully on a half-open success, but re-opens immediately on a half-open failure", () => {
    vi.useFakeTimers();
    fail("chatgpt", 3);
    fail("copilot", 3);
    vi.advanceTimersByTime(61_000);

    recordProviderOutcome("chatgpt", true);
    // Fully reset, not left mid-count: one more failure keeps it closed.
    fail("chatgpt", 1);
    expect(isProviderOpen("chatgpt")).toBe(false);

    fail("copilot", 1);
    expect(isProviderOpen("copilot")).toBe(true);
  });
});
