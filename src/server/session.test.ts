import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  revokeSessions,
  SESSION_MAX_AGE_MS,
  authEnabled,
  signSession,
  verifySession,
  isAllowedOrigin,
  isAllowedUnauthenticatedHost,
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

describe("revokeSessions", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-revoke-"));
    file = path.join(dir, "sessions-not-before");
    process.env.RADULF_SESSIONS_NOT_BEFORE_FILE = file;
  });
  afterEach(() => {
    delete process.env.RADULF_SESSIONS_NOT_BEFORE_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("voids every session issued up to the revocation, and none after it", async () => {
    const issuedAt = Date.now();
    const before = await signSession(issuedAt + SESSION_MAX_AGE_MS);
    expect(await verifySession(before)).toBe(true);

    await revokeSessions(issuedAt);
    expect(await verifySession(before)).toBe(false);

    const after = await signSession(issuedAt + 1 + SESSION_MAX_AGE_MS);
    expect(await verifySession(after)).toBe(true);
  });

  it.each(["", "garbage", "NaN", "-1", "1.5", "9007199254740992"])("rejects sessions when the stamp is invalid: %j", async (stamp) => {
    const cookie = await signSession(Date.now() + SESSION_MAX_AGE_MS);
    fs.writeFileSync(file, stamp);
    expect(await verifySession(cookie)).toBe(false);
    await expect(revokeSessions()).rejects.toThrow("invalid session revocation stamp");
  });

  it("rejects sessions when the stamp cannot be read", async () => {
    fs.mkdirSync(file);
    expect(await verifySession(await signSession(Date.now() + SESSION_MAX_AGE_MS))).toBe(false);
  });

  it("never lowers the stamp when an older logout finishes later", async () => {
    const issuedAt = Date.now();
    const cookie = await signSession(issuedAt + SESSION_MAX_AGE_MS);
    await revokeSessions(issuedAt + 1);
    await revokeSessions(issuedAt - 1);
    expect(await verifySession(cookie)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(String(issuedAt + 1));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces the stamp without truncating the file a reader already opened", async () => {
    const issuedAt = Date.now();
    await revokeSessions(issuedAt);
    const reader = fs.openSync(file, "r");
    try {
      await revokeSessions(issuedAt + 1);
      expect(fs.readFileSync(reader, "utf8")).toBe(String(issuedAt));
      expect(fs.readFileSync(file, "utf8")).toBe(String(issuedAt + 1));
    } finally {
      fs.closeSync(reader);
    }
  });

  it("serializes concurrent logout processes without exposing an empty stamp", async () => {
    const issuedAt = Date.now();
    const cookie = await signSession(issuedAt + SESSION_MAX_AGE_MS);
    await revokeSessions(issuedAt);
    // Run the actual module in independent Node processes, sharing only disk.
    const source = fs.readFileSync(path.join(process.cwd(), "src/server/session.ts"), "utf8")
      .replace('import("@/db/migrationLock")', `import(${JSON.stringify(path.join(process.cwd(), "src/db/migrationLock.ts"))})`);
    const sessionModule = path.join(process.cwd(), `.session-test-${process.pid}.ts`);
    fs.writeFileSync(sessionModule, source);
    try {
      const run = promisify(execFile);
      const writers = [issuedAt + 20, issuedAt + 10, issuedAt + 30].map((stamp) =>
        run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { revokeSessions } from ${JSON.stringify(sessionModule)}; await revokeSessions(${stamp});`]),
      );
      for (let i = 0; i < 30; i++) expect(await verifySession(cookie)).toBe(false);
      await Promise.all(writers);
      expect(fs.readFileSync(file, "utf8")).toBe(String(issuedAt + 30));
    } finally {
      fs.rmSync(sessionModule, { force: true });
    }
  });
});

describe("isAllowedOrigin", () => {
  it("accepts only the request's own host and port, or no Origin at all", () => {
    for (const origin of [null, "http://localhost:3000", "https://localhost:3000"]) {
      expect(isAllowedOrigin(origin, "localhost:3000")).toBe(true);
    }
    expect(isAllowedOrigin("http://127.0.0.1:3000", "127.0.0.1:3000")).toBe(true);
    expect(isAllowedOrigin("http://localhost", "localhost")).toBe(true);
    for (const origin of ["https://evil.com", "http://192.168.1.1", "https://radulf.example.com", "not-a-url"]) {
      expect(isAllowedOrigin(origin, "localhost:3000")).toBe(false);
    }
  });

  it("rejects another localhost port: browsers treat every localhost port as one site", () => {
    // A page on any other local dev server gets the session cookie under
    // SameSite=Lax and needs no preflight for a text/plain POST — so the
    // Origin check is the only thing standing between it and the board.
    expect(isAllowedOrigin("http://localhost:8080", "localhost:3000")).toBe(false);
    expect(isAllowedOrigin("http://localhost", "localhost:3000")).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:3000", "localhost:3000")).toBe(false);
  });

  it("does not trust a matching non-loopback Host header", () => {
    expect(isAllowedOrigin("https://attacker.example", "attacker.example")).toBe(false);
  });

  it("accepts only the full origin named by RADULF_ALLOWED_ORIGIN", () => {
    process.env.RADULF_ALLOWED_ORIGIN = "https://radulf.example.com";
    try {
      expect(isAllowedOrigin("https://radulf.example.com", "127.0.0.1:3000")).toBe(true);
      expect(isAllowedOrigin("https://radulf.example.com:443", "127.0.0.1:3000")).toBe(true);
      expect(isAllowedOrigin("http://radulf.example.com", "127.0.0.1:3000")).toBe(false);
      expect(isAllowedOrigin("https://radulf.example.com:8443", "127.0.0.1:3000")).toBe(false);
      expect(isAllowedOrigin("https://radulf.example.evil.com", "127.0.0.1:3000")).toBe(false);
    } finally {
      delete process.env.RADULF_ALLOWED_ORIGIN;
    }
  });
});

describe("isAllowedUnauthenticatedHost", () => {
  it("accepts exact loopback hosts and rejects DNS rebinding hosts", () => {
    for (const host of ["localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(isAllowedUnauthenticatedHost(host)).toBe(true);
    }
    for (const host of ["attacker.example:3000", "localhost.attacker.example", "192.168.1.20:3000", "not a host/"]) {
      expect(isAllowedUnauthenticatedHost(host)).toBe(false);
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
    process.env.RADULF_ALLOWED_ORIGIN = "http://192.168.100.68:3000";
    try {
      const base = redirectBase(req("http://192.168.100.68:3000"));
      expect(new URL("/", base).href).toBe("http://192.168.100.68:3000/");
    } finally {
      delete process.env.RADULF_ALLOWED_ORIGIN;
    }
  });

  it("accepts the origin matching the Host the browser addressed", () => {
    const request = new Request("http://0.0.0.0:3000/api/auth/login", {
      method: "POST",
      headers: { origin: "http://localhost:3000", host: "localhost:3000" },
    });
    expect(new URL("/", redirectBase(request)).href).toBe("http://localhost:3000/");
    // A localhost origin on a different port is not this site.
    expect(redirectBase(req("http://localhost:3000"))).toBe("http://0.0.0.0:3000/api/auth/login");
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
