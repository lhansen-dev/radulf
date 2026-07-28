import { describe, it, expect, beforeAll } from "vitest";
import {
  SESSION_MAX_AGE_MS,
  authEnabled,
  signSession,
  verifySession,
  isAllowedOrigin,
} from "./session";

const TEST_SECRET = "4e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f";

beforeAll(() => {
  process.env.RADULF_AUTH_SECRET = TEST_SECRET;
});

describe("authEnabled", () => {
  it("returns false when RADULF_AUTH_PASSWORD_HASH is unset", () => {
    delete process.env.RADULF_AUTH_PASSWORD_HASH;
    expect(authEnabled()).toBe(false);
  });

  it("returns true when RADULF_AUTH_PASSWORD_HASH is set", () => {
    process.env.RADULF_AUTH_PASSWORD_HASH = "$2a$12$abc123";
    expect(authEnabled()).toBe(true);
    delete process.env.RADULF_AUTH_PASSWORD_HASH;
  });
});

describe("signSession / verifySession", () => {
  it("sign→verify roundtrip returns true", async () => {
    const future = Date.now() + SESSION_MAX_AGE_MS;
    const cookie = await signSession(future);
    expect(await verifySession(cookie)).toBe(true);
  });

  it("a tampered value verifies false", async () => {
    const future = Date.now() + SESSION_MAX_AGE_MS;
    const cookie = await signSession(future);
    // Tamper: modify the first digit of the timestamp
    const tampered = "9" + cookie.slice(1);
    expect(await verifySession(tampered)).toBe(false);
  });

  it("an expired timestamp verifies false", async () => {
    const past = Date.now() - 1000; // 1 second ago
    const cookie = await signSession(past);
    expect(await verifySession(cookie)).toBe(false);
  });

  it("a malformed cookie value verifies false", async () => {
    expect(await verifySession("")).toBe(false);
    expect(await verifySession("no-dot")).toBe(false);
    expect(await verifySession("123.456.abc")).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("accepts localhost origins", () => {
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin("http://localhost")).toBe(true);
    expect(isAllowedOrigin("https://localhost:3000")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1")).toBe(true);
  });

  it("accepts the host named by RADULF_ALLOWED_ORIGIN", () => {
    process.env.RADULF_ALLOWED_ORIGIN = "radulf.example.com";
    try {
      expect(isAllowedOrigin("https://radulf.example.com")).toBe(true);
      expect(isAllowedOrigin("https://radulf.example.com:443")).toBe(true);
      expect(isAllowedOrigin("https://radulf.example.evil.com")).toBe(false);
    } finally {
      delete process.env.RADULF_ALLOWED_ORIGIN;
    }
  });

  it("rejects non-localhost origins when RADULF_ALLOWED_ORIGIN is unset", () => {
    expect(isAllowedOrigin("https://evil.com")).toBe(false);
    expect(isAllowedOrigin("https://example.com")).toBe(false);
    expect(isAllowedOrigin("http://192.168.1.1")).toBe(false);
    expect(isAllowedOrigin("https://radulf.example.com")).toBe(false);
  });

  it("returns true for null origin (same-origin request)", () => {
    expect(isAllowedOrigin(null)).toBe(true);
  });

  it("returns false for an unparseable origin", () => {
    expect(isAllowedOrigin("not-a-url")).toBe(false);
  });
});
