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
  it("matches connection/auth-shaped errors", () => {
    expect(CONN_ERROR_PATTERN.test("fetch failed")).toBe(true);
    expect(CONN_ERROR_PATTERN.test("401 Unauthorized")).toBe(true);
    expect(CONN_ERROR_PATTERN.test("ECONNREFUSED")).toBe(true);
  });

  it("does not match an unrelated failure", () => {
    expect(CONN_ERROR_PATTERN.test("plan checklist unparseable")).toBe(false);
  });
});

describe("circuit breaker state machine", () => {
  it("starts closed", () => {
    expect(isProviderOpen("anthropic")).toBe(false);
  });

  it("stays closed until the failure threshold is reached", () => {
    recordProviderOutcome("anthropic", false);
    expect(isProviderOpen("anthropic")).toBe(false);
    recordProviderOutcome("anthropic", false);
    expect(isProviderOpen("anthropic")).toBe(false);
  });

  it("opens after the third consecutive failure and blocks calls within the cooldown", () => {
    recordProviderOutcome("openrouter", false);
    recordProviderOutcome("openrouter", false);
    recordProviderOutcome("openrouter", false);
    expect(isProviderOpen("openrouter")).toBe(true);
  });

  it("goes half-open (allowed through) once the cooldown elapses", () => {
    vi.useFakeTimers();
    recordProviderOutcome("omlx", false);
    recordProviderOutcome("omlx", false);
    recordProviderOutcome("omlx", false);
    expect(isProviderOpen("omlx")).toBe(true);

    vi.advanceTimersByTime(61_000);
    expect(isProviderOpen("omlx")).toBe(false);
  });

  it("half-open success closes the breaker", () => {
    vi.useFakeTimers();
    recordProviderOutcome("chatgpt", false);
    recordProviderOutcome("chatgpt", false);
    recordProviderOutcome("chatgpt", false);
    vi.advanceTimersByTime(61_000);
    expect(isProviderOpen("chatgpt")).toBe(false); // half-open probe allowed

    recordProviderOutcome("chatgpt", true);
    expect(isProviderOpen("chatgpt")).toBe(false);

    // A single subsequent failure should not reopen it — the breaker was
    // fully reset, not left mid-count.
    recordProviderOutcome("chatgpt", false);
    expect(isProviderOpen("chatgpt")).toBe(false);
  });

  it("half-open failure re-opens the breaker immediately", () => {
    vi.useFakeTimers();
    recordProviderOutcome("copilot", false);
    recordProviderOutcome("copilot", false);
    recordProviderOutcome("copilot", false);
    vi.advanceTimersByTime(61_000);
    expect(isProviderOpen("copilot")).toBe(false); // half-open probe allowed

    recordProviderOutcome("copilot", false);
    expect(isProviderOpen("copilot")).toBe(true);
  });

  it("tracks providers independently", () => {
    recordProviderOutcome("anthropic", false);
    recordProviderOutcome("anthropic", false);
    recordProviderOutcome("anthropic", false);
    expect(isProviderOpen("anthropic")).toBe(true);
    expect(isProviderOpen("openrouter")).toBe(false);
  });

  it("omlx trips open in fewer consecutive failures than anthropic (per-provider thresholds)", () => {
    // omlx's failureThreshold (2) is lower than anthropic's (3) — a local
    // process is expected to fail/recover fast, so it should trip sooner.
    recordProviderOutcome("omlx", false);
    expect(isProviderOpen("omlx")).toBe(false);
    recordProviderOutcome("omlx", false);
    expect(isProviderOpen("omlx")).toBe(true);

    // The same two failures leave anthropic's breaker (threshold 3) closed.
    recordProviderOutcome("anthropic", false);
    recordProviderOutcome("anthropic", false);
    expect(isProviderOpen("anthropic")).toBe(false);
  });

  it("omlx's cooldown (15s) elapses before anthropic's (60s)", () => {
    vi.useFakeTimers();
    recordProviderOutcome("omlx", false);
    recordProviderOutcome("omlx", false);
    recordProviderOutcome("anthropic", false);
    recordProviderOutcome("anthropic", false);
    recordProviderOutcome("anthropic", false);
    expect(isProviderOpen("omlx")).toBe(true);
    expect(isProviderOpen("anthropic")).toBe(true);

    vi.advanceTimersByTime(16_000);
    expect(isProviderOpen("omlx")).toBe(false); // omlx's 15s cooldown has elapsed
    expect(isProviderOpen("anthropic")).toBe(true); // anthropic's 60s cooldown has not
  });
});
