import { describe, it, expect, beforeAll } from "vitest";
import {
  SESSION_MAX_AGE_MS,
  authEnabled,
  signSession,
  verifySession,
  isAllowedOrigin,
  redirectBase,
} from "./session";

const TEST_SECRET = "4e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f";

beforeAll(() => {
  process.env.RADULF_AUTH_SECRET = TEST_SECRET;
});

describe("authEnabled", () => {
  it("is on exactly when RADULF_AUTH_PASSWORD_HASH is set", () => {
    delete process.env.RADULF_AUTH_PASSWORD_HASH;
    expect(authEnabled()).toBe(false);
    process.env.RADULF_AUTH_PASSWORD_HASH = "$2a$12$abc123";
    try {
      expect(authEnabled()).toBe(true);
    } finally {
      delete process.env.RADULF_AUTH_PASSWORD_HASH;
    }
  });
});

describe("signSession / verifySession", () => {
  it("verifies a signed, unexpired session", async () => {
    expect(await verifySession(await signSession(Date.now() + SESSION_MAX_AGE_MS))).toBe(true);
  });

  it("rejects a tampered, expired, or malformed cookie", async () => {
    const cookie = await signSession(Date.now() + SESSION_MAX_AGE_MS);
    for (const bad of ["9" + cookie.slice(1), await signSession(Date.now() - 1000), "", "no-dot", "123.456.abc"]) {
      expect(await verifySession(bad)).toBe(false);
    }
  });

  // Regression: these reach the base64 decode, where the expired and
  // past-dated cases above return first. `atob` throws on a stray character,
  // and verifySession runs inside the proxy on EVERY request — so throwing
  // here turned any garbage cookie into a 500 on every route rather than a
  // redirect to /login, unauthenticated and trivially reachable.
  it("rejects, rather than throws on, a signature that is not valid base64", async () => {
    const future = Date.now() + SESSION_MAX_AGE_MS;
    for (const signature of ["not-valid-base64!!", "!!!!", "%%%%", "a b c", "\u0000"]) {
      await expect(verifySession(`${future}.${signature}`)).resolves.toBe(false);
    }
  });
});

describe("isAllowedOrigin", () => {
  it("accepts localhost and same-origin (null) requests, rejecting everything else by default", () => {
    for (const origin of [
      null,
      "http://localhost:3000",
      "http://localhost",
      "https://localhost:3000",
      "http://127.0.0.1:3000",
      "http://127.0.0.1",
    ]) {
      expect(isAllowedOrigin(origin)).toBe(true);
    }
    for (const origin of ["https://evil.com", "http://192.168.1.1", "https://radulf.example.com", "not-a-url"]) {
      expect(isAllowedOrigin(origin)).toBe(false);
    }
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
});

describe("redirectBase", () => {
  const req = (origin: string | null) =>
    new Request("http://0.0.0.0:3000/api/auth/login", {
      method: "POST",
      headers: origin ? { origin } : {},
    });

  it("redirects to the origin the browser actually used, not the bind address", () => {
    process.env.RADULF_ALLOWED_ORIGIN = "192.168.100.68";
    try {
      const base = redirectBase(req("http://192.168.100.68:3000"));
      expect(new URL("/", base).href).toBe("http://192.168.100.68:3000/");
    } finally {
      delete process.env.RADULF_ALLOWED_ORIGIN;
    }
  });

  it("accepts a localhost origin", () => {
    const base = redirectBase(req("http://localhost:3000"));
    expect(new URL("/", base).href).toBe("http://localhost:3000/");
  });

  it("falls back to request.url when no Origin is sent (curl, scripts)", () => {
    expect(redirectBase(req(null))).toBe("http://0.0.0.0:3000/api/auth/login");
  });

  it("ignores a foreign Origin rather than redirecting to it", () => {
    expect(redirectBase(req("https://evil.example.com"))).toBe(
      "http://0.0.0.0:3000/api/auth/login",
    );
  });
});
