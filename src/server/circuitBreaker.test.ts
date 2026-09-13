import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-circuit-breaker-"));
process.env.RADULF_DATA_DIR = testDataDir;

const { db, settings } = await import("@/db");
const { recordProviderOutcome, isProviderOpen, CONN_ERROR_PATTERN } = await import(
  "./circuitBreaker"
);

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
