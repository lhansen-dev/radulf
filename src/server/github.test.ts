import { describe, expect, it, vi, beforeEach } from "vitest";

// `gh auth status` prints for humans, and the account name is scraped from it
// (spec 15). That makes the parse a real dependency on another tool's output
// format, so it gets a test pinned to gh's actual wording rather than being
// left to fail silently into "signed in, unnamed" on the next gh release.

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

const { githubStatus, findOpenPullRequest } = await import("./github");

/** Stand in for execFile: resolve `gh auth status` with the given stderr, or
 * fail it — with `code` set the way execFile reports a spawn failure.
 *
 * `out` arrives as execFile's stderr argument because that is where gh puts
 * everything a human reads; `stdout` is separate so a JSON-producing call such
 * as `gh pr list --json` can be fed the way gh really feeds it. */
function ghReturns(
  handler: () => { fail?: boolean; code?: string | number; out?: string; stdout?: string },
) {
  mocks.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => {
      const { fail, code, out = "", stdout = "" } = handler();
      const err = fail ? Object.assign(new Error("exit 1"), code ? { code } : {}) : null;
      queueMicrotask(() => cb(err, stdout, out));
      return { stdin: { end: () => {} }, kill: () => {} };
    },
  );
}

describe("githubStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the account name out of gh's real auth-status wording", async () => {
    ghReturns(() => ({
      out: [
        "github.com",
        "  ✓ Logged in to github.com account lhansen-dev (keyring)",
        "  - Active account: true",
        "  - Git operations protocol: https",
      ].join("\n"),
    }));

    // `refresh` because the module caches for 30s and these cases share it.
    const status = await githubStatus({ refresh: true });

    expect(status).toEqual({ ok: true, account: "lhansen-dev" });
  });

  it("stays ok, just unnamed, when the account cannot be parsed", async () => {
    ghReturns(() => ({ out: "some future wording" }));

    expect(await githubStatus({ refresh: true })).toEqual({ ok: true });
  });

  it("distinguishes a missing gh from a logged-out one", async () => {
    // No `gh` on PATH: execFile cannot spawn it and reports ENOENT.
    ghReturns(() => ({ fail: true, code: "ENOENT" }));
    expect(await githubStatus({ refresh: true })).toMatchObject({ ok: false, reason: "missing" });

    // A `gh` that exists but is not executable also fails at spawn, as EACCES.
    ghReturns(() => ({ fail: true, code: "EACCES" }));
    expect(await githubStatus({ refresh: true })).toMatchObject({ ok: false, reason: "missing" });

    // `gh` runs but `auth status` exits non-zero: a numeric exit status.
    ghReturns(() => ({ fail: true, code: 1 }));
    expect(await githubStatus({ refresh: true })).toMatchObject({
      ok: false,
      reason: "unauthenticated",
    });
  });

  it("caches, and refresh bypasses the cache", async () => {
    ghReturns(() => ({ out: "account alice" }));
    await githubStatus({ refresh: true });
    const callsAfterFirst = mocks.execFile.mock.calls.length;

    await githubStatus();
    expect(mocks.execFile.mock.calls.length).toBe(callsAfterFirst);

    await githubStatus({ refresh: true });
    expect(mocks.execFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

describe("findOpenPullRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the open PR gh found, and asks for it by head and base", async () => {
    ghReturns(() => ({
      stdout: JSON.stringify([{ url: "https://github.com/o/r/pull/7", isDraft: true }]),
    }));

    const result = await findOpenPullRequest({
      worktreePath: "/tmp/wt",
      baseBranch: "main",
      branch: "ralph/x",
    });

    expect(result).toEqual({
      ok: true,
      pr: { url: "https://github.com/o/r/pull/7", isDraft: true },
    });
    expect(mocks.execFile.mock.calls[0][1]).toEqual([
      "pr",
      "list",
      "--head",
      "ralph/x",
      "--base",
      "main",
      "--state",
      "open",
      "--json",
      "url,isDraft",
      "--limit",
      "1",
    ]);
  });

  it("reports no PR to adopt when gh's list comes back empty", async () => {
    ghReturns(() => ({ stdout: "[]" }));

    expect(
      await findOpenPullRequest({ worktreePath: "/tmp/wt", baseBranch: "main", branch: "ralph/x" }),
    ).toEqual({ ok: true, pr: null });
  });

  it("fails loudly when the lookup itself fails, rather than saying 'no PR'", async () => {
    ghReturns(() => ({ fail: true, code: 1, out: "boom" }));

    expect(
      await findOpenPullRequest({ worktreePath: "/tmp/wt", baseBranch: "main", branch: "ralph/x" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("boom") });
  });
});
