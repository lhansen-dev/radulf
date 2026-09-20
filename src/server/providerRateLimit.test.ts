import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-rate-limit-"));
process.env.RADULF_DATA_DIR = testDataDir;

const { db, settings } = await import("@/db");
const {
  observeRateLimitHeaders,
  readProviderRateLimit,
  rateLimitCooldownMs,
  limitCooldownMs,
} = await import("./providerRateLimit");

afterAll(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.RADULF_DATA_DIR;
});

beforeEach(() => {
  db.delete(settings).run();
});

const exhausted = (resetEpochSeconds: number) => ({
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-reset": String(resetEpochSeconds),
  "anthropic-ratelimit-unified-7d-utilization": "1.0",
});

describe("observeRateLimitHeaders", () => {
  it("stores a reading and reads it back", () => {
    observeRateLimitHeaders("anthropic", {
      "anthropic-ratelimit-unified-status": "allowed_warning",
      "anthropic-ratelimit-unified-7d-utilization": "0.8",
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
    });
    const reading = readProviderRateLimit("anthropic")!;
    expect(reading.status).toBe("warning");
    expect(reading.bindingWindow).toBe("7d");
  });

  it("overwrites rather than accumulating — only the current standing matters", () => {
    observeRateLimitHeaders("anthropic", { "anthropic-ratelimit-unified-status": "allowed" });
    observeRateLimitHeaders("anthropic", { "anthropic-ratelimit-unified-status": "rejected" });
    expect(readProviderRateLimit("anthropic")!.status).toBe("exhausted");
    expect(db.select().from(settings).all()).toHaveLength(1);
  });

  it("records nothing for a provider that sends no such headers", () => {
    observeRateLimitHeaders("omlx", { "content-type": "application/json" });
    expect(readProviderRateLimit("omlx")).toBeNull();
  });

  it("never throws out into the agent's hot path", () => {
    expect(() => observeRateLimitHeaders("anthropic", undefined)).not.toThrow();
    // A header value of the wrong shape must not take a run down with it.
    expect(() =>
      observeRateLimitHeaders("anthropic", { "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-reset": "{}" }),
    ).not.toThrow();
  });

  it("reads a corrupt stored row as absent", () => {
    db.insert(settings).values({ key: "rateLimit:anthropic", value: "not json" }).run();
    expect(readProviderRateLimit("anthropic")).toBeNull();
  });
});

describe("cooldowns from the observed reset", () => {
  const nowMs = Date.parse("2026-09-20T12:00:00.000Z");
  const inOneHour = Math.floor((nowMs + 3_600_000) / 1000);

  it("waits exactly until the provider's own reset instant", () => {
    observeRateLimitHeaders("anthropic", exhausted(inOneHour));
    expect(rateLimitCooldownMs("anthropic", nowMs)).toBe(3_600_000);
  });

  it("prefers the observed reset over a duration named in the error text", () => {
    observeRateLimitHeaders("anthropic", exhausted(inOneHour));
    expect(limitCooldownMs("anthropic", "429 rate limit; retry after 30 seconds", nowMs)).toBe(3_600_000);
  });

  it("falls back to the error text when there is no reading", () => {
    expect(limitCooldownMs("anthropic", "429 rate limit; retry after 30 seconds", nowMs)).toBe(30_000);
  });

  it("falls through to null when neither source says anything", () => {
    expect(limitCooldownMs("anthropic", "429 Too Many Requests", nowMs)).toBeNull();
  });

  it("ignores a reading that says the account is fine — a limit error then came from elsewhere", () => {
    observeRateLimitHeaders("anthropic", {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": String(inOneHour),
    });
    expect(rateLimitCooldownMs("anthropic", nowMs)).toBeNull();
  });

  it("ignores a reset that has already passed", () => {
    observeRateLimitHeaders("anthropic", exhausted(Math.floor((nowMs - 60_000) / 1000)));
    expect(rateLimitCooldownMs("anthropic", nowMs)).toBeNull();
  });
});
