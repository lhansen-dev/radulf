import { describe, expect, it, vi, beforeEach } from "vitest";

// `gh auth status` prints for humans, and the account name is scraped from it
// (spec 15). That makes the parse a real dependency on another tool's output
// format, so it gets a test pinned to gh's actual wording rather than being
// left to fail silently into "signed in, unnamed" on the next gh release.

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

const { githubStatus } = await import("./github");

/** Stand in for execFile: resolve `gh <args>` with the given stdout/stderr. */
function ghReturns(handler: (args: string[]) => { fail?: boolean; out?: string }) {
  mocks.execFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => {
      const { fail, out = "" } = handler(args);
      queueMicrotask(() => cb(fail ? new Error("exit 1") : null, "", out));
      return { stdin: { end: () => {} }, kill: () => {} };
    },
  );
}

describe("githubStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the account name out of gh's real auth-status wording", async () => {
    ghReturns((args) =>
      args[0] === "--version"
        ? { out: "gh version 2.96.0 (2026-07-02)" }
        : {
            out: [
              "github.com",
              "  ✓ Logged in to github.com account lhansen-dev (keyring)",
              "  - Active account: true",
              "  - Git operations protocol: https",
            ].join("\n"),
          },
    );

    // `refresh` because the module caches for 30s and these cases share it.
    const status = await githubStatus({ refresh: true });

    expect(status).toEqual({ ok: true, account: "lhansen-dev" });
  });

  it("stays ok, just unnamed, when the account cannot be parsed", async () => {
    ghReturns((args) =>
      args[0] === "--version" ? { out: "gh version 3.0.0" } : { out: "some future wording" },
    );

    expect(await githubStatus({ refresh: true })).toEqual({ ok: true });
  });

  it("distinguishes a missing gh from a logged-out one", async () => {
    ghReturns(() => ({ fail: true }));
    expect(await githubStatus({ refresh: true })).toMatchObject({ ok: false, reason: "missing" });

    ghReturns((args) => (args[0] === "--version" ? { out: "gh version 2.96.0" } : { fail: true }));
    expect(await githubStatus({ refresh: true })).toMatchObject({
      ok: false,
      reason: "unauthenticated",
    });
  });

  it("caches, and refresh bypasses the cache", async () => {
    ghReturns((args) =>
      args[0] === "--version" ? { out: "gh version 2.96.0" } : { out: "account alice" },
    );
    await githubStatus({ refresh: true });
    const callsAfterFirst = mocks.execFile.mock.calls.length;

    await githubStatus();
    expect(mocks.execFile.mock.calls.length).toBe(callsAfterFirst);

    await githubStatus({ refresh: true });
    expect(mocks.execFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
