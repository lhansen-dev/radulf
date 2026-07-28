import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { SESSION_COOKIE, signSession } from "@/server/session";
import {
  BASE_FAILURE_DELAY_MS,
  isLoginRateLimited,
  loginClientKey,
  loginFailureDelayMs,
  recordLoginFailure,
  resetLoginRateLimit,
} from "@/server/loginRateLimit";
import { POST as login } from "./login/route";
import { POST as logout } from "./logout/route";

const PASSWORD = "correct horse battery staple";
const SECRET = "4e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f";

function loginRequest(password: string, url = "http://localhost/api/auth/login") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

async function failedLogin(password = "wrong") {
  const response = login(loginRequest(password));
  // Enough to clear the escalating shared-bucket stall (capped at 15s).
  await vi.advanceTimersByTimeAsync(20_000);
  return response;
}

describe("authentication routes", () => {
  beforeEach(() => {
    resetLoginRateLimit();
    process.env.RADULF_AUTH_SECRET = SECRET;
    process.env.RADULF_AUTH_PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
    delete process.env.RADULF_TRUSTED_PROXY_IP_HEADER;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLoginRateLimit();
    delete process.env.RADULF_AUTH_PASSWORD_HASH;
    delete process.env.RADULF_TRUSTED_PROXY_IP_HEADER;
  });

  it("does not count successful logins toward the failure limit", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await login(loginRequest(PASSWORD));
      expect(response.status).toBe(307);
    }
  });

  it("records only failures and clears them on success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));

    expect((await failedLogin()).status).toBe(401);
    expect((await failedLogin()).status).toBe(401);
    expect((await login(loginRequest(PASSWORD))).status).toBe(307);
    expect(isLoginRateLimited(loginClientKey(loginRequest("x")))).toBe(false);
  });

  it("hard-limits an identified client once a trusted proxy header names it", async () => {
    process.env.RADULF_TRUSTED_PROXY_IP_HEADER = "x-forwarded-for";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));

    const from = (ip: string) =>
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ password: "wrong" }),
      });
    // Reading the request body needs the loop pumped, so every call under fake
    // timers must advance them — including the ones that answer immediately.
    // Advance only past the flat identified-client delay: burning 20s a call
    // would slide attempts out of the 60s failure window before the 6th.
    const attempt = async (ip: string) => {
      const response = login(from(ip));
      await vi.advanceTimersByTimeAsync(BASE_FAILURE_DELAY_MS);
      return response;
    };

    for (let i = 0; i < 5; i++) expect((await attempt("203.0.113.7")).status).toBe(401);

    const blocked = await attempt("203.0.113.7");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "Too many attempts. Try again later." });

    // A different address has its own bucket and is unaffected.
    expect((await attempt("198.51.100.9")).status).toBe(401);
  });

  it("escalates the shared-bucket delay and caps it", () => {
    // Pure unit on the delay curve, at a fixed instant so the 60s failure
    // window cannot retire earlier failures mid-assertion.
    const at = 1_000;
    expect(loginFailureDelayMs("shared", at)).toBe(1_000); // no failures: baseline
    recordLoginFailure("shared", at);
    expect(loginFailureDelayMs("shared", at)).toBe(3_000);
    recordLoginFailure("shared", at);
    expect(loginFailureDelayMs("shared", at)).toBe(5_000);
    for (let i = 0; i < 20; i++) recordLoginFailure("shared", at);
    expect(loginFailureDelayMs("shared", at)).toBe(15_000); // capped
  });

  it("never locks the operator out of the shared bucket — it stalls instead", async () => {
    // No trusted proxy header: every direct client shares one bucket, so a hard
    // cutoff would let anyone on the network lock the operator out. Guessing
    // gets slower; the right password is never refused.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));

    for (let i = 0; i < 8; i++) expect((await failedLogin()).status).toBe(401);

    const success = login(loginRequest(PASSWORD));
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await success).status).toBe(307);
  });

  it("sets a signed HttpOnly session cookie with transport security matching the request", async () => {
    const httpResponse = await login(loginRequest(PASSWORD));
    const httpCookie = httpResponse.headers.get("set-cookie") ?? "";
    expect(httpCookie).toContain(`${SESSION_COOKIE}=`);
    expect(httpCookie).toContain("HttpOnly");
    expect(httpCookie).toContain("SameSite=lax");
    expect(httpCookie).not.toContain("Secure");

    const httpsResponse = await login(loginRequest(PASSWORD, "https://radulf.example/api/auth/login"));
    expect(httpsResponse.headers.get("set-cookie")).toContain("Secure");
  });

  it("uses forwarded addresses only through an explicitly trusted proxy header", () => {
    const request = new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(loginClientKey(request)).toBe("direct-client");

    process.env.RADULF_TRUSTED_PROXY_IP_HEADER = "x-forwarded-for";
    expect(loginClientKey(request)).toBe("203.0.113.7");
  });

  it("expires old failure windows", () => {
    for (let attempt = 0; attempt < 5; attempt++) recordLoginFailure("client", 1_000);
    expect(isLoginRateLimited("client", 1_000)).toBe(true);
    expect(isLoginRateLimited("client", 61_001)).toBe(false);
  });

  it("builds logout redirects from the incoming origin and expires the cookie", async () => {
    const response = await logout(
      new Request("https://radulf.example/api/auth/logout", { method: "POST" }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://radulf.example/login");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
  });

  it("rejects cross-origin mutations even with auth disabled", async () => {
    // The no-auth default is exactly when this matters: a page the operator
    // visits must not be able to drive their localhost instance.
    delete process.env.RADULF_AUTH_PASSWORD_HASH;

    const forbidden = await proxy(
      new NextRequest("http://localhost:3000/api/settings", {
        method: "PATCH",
        headers: { origin: "https://evil.example", "content-type": "text/plain" },
      }),
    );
    expect(forbidden.status).toBe(403);

    // Same-origin still passes through.
    const allowed = await proxy(
      new NextRequest("http://localhost:3000/api/settings", {
        method: "PATCH",
        headers: { origin: "http://localhost:3000" },
      }),
    );
    expect(allowed.headers.get("x-middleware-next")).toBe("1");

    // A non-browser client sends no Origin and is unaffected.
    const noOrigin = await proxy(
      new NextRequest("http://localhost:3000/api/settings", { method: "PATCH" }),
    );
    expect(noOrigin.headers.get("x-middleware-next")).toBe("1");

    // Reads are never origin-checked.
    const read = await proxy(
      new NextRequest("http://localhost:3000/api/settings", {
        method: "GET",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(read.headers.get("x-middleware-next")).toBe("1");
  });

  it("origin-checks the login route itself, so a session cannot be forced", async () => {
    const forbidden = await proxy(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("enforces API sessions and rejects cross-origin mutations", async () => {
    process.env.RADULF_ALLOWED_ORIGIN = "radulf.example.com";
    try {
      const unauthorized = await proxy(
        new NextRequest("https://radulf.example.com/api/cards", { method: "GET" }),
      );
      expect(unauthorized.status).toBe(401);

      const session = await signSession(Date.now() + 60_000);
      const forbidden = await proxy(
        new NextRequest("https://radulf.example.com/api/cards", {
          method: "POST",
          headers: {
            cookie: `${SESSION_COOKIE}=${session}`,
            origin: "https://evil.example",
          },
        }),
      );
      expect(forbidden.status).toBe(403);

      const allowed = await proxy(
        new NextRequest("https://radulf.example.com/api/cards", {
          method: "POST",
          headers: {
            cookie: `${SESSION_COOKIE}=${session}`,
            origin: "https://radulf.example.com",
          },
        }),
      );
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("x-middleware-next")).toBe("1");
    } finally {
      delete process.env.RADULF_ALLOWED_ORIGIN;
    }
  });
});
