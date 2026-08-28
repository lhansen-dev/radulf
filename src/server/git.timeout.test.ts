import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

// git.ts calls execFile directly (not promisify(execFile)) so it can keep a
// handle on the ChildProcess for the SIGTERM→SIGKILL escalation — the mock
// has to match that calling convention: (cmd, args, options, callback),
// returning an object with a `.kill(signal)` method.
vi.mock("node:child_process", () => ({
  execFile: (
    ...args: [string, string[], object, (err: unknown, stdout: string, stderr: string) => void]
  ) => mocks.execFile(...args),
}));

const { git, tryGit } = await import("./git");

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("git()/tryGit() bounded timeout on a hung child process", () => {
  it("rejects within GIT_TIMEOUT_MS + GIT_KILL_GRACE_MS, escalating SIGTERM then SIGKILL", async () => {
    vi.useFakeTimers();
    const signals: string[] = [];
    let callback: ((err: unknown, stdout: string, stderr: string) => void) | undefined;
    mocks.execFile.mockImplementation((_cmd, _args, _options, cb) => {
      callback = cb;
      return {
        // Simulates a process wedged in a blocking syscall: ignores SIGTERM
        // and only actually dies once SIGKILL is sent, proving the
        // escalation (not just the first signal) is what unblocks the call.
        kill: (signal: string) => {
          signals.push(signal);
          if (signal === "SIGKILL") {
            callback?.(
              Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" }),
              "",
              ""
            );
          }
        },
      };
    });

    const promise = git("/fake/repo", "status");
    const assertion = expect(promise).rejects.toThrow(/git status timed out after 30000ms/);
    await vi.advanceTimersByTimeAsync(35_000);
    await assertion;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("tryGit()'s returned `out` also names the timeout instead of going silently empty", async () => {
    vi.useFakeTimers();
    let callback: ((err: unknown, stdout: string, stderr: string) => void) | undefined;
    mocks.execFile.mockImplementation((_cmd, _args, _options, cb) => {
      callback = cb;
      return {
        kill: (signal: string) => {
          if (signal === "SIGKILL") {
            callback?.(
              Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" }),
              "",
              ""
            );
          }
        },
      };
    });

    const promise = tryGit("/fake/repo", "status");
    await vi.advanceTimersByTimeAsync(35_000);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/git status timed out after 30000ms/);
  });

  it("never fires SIGKILL when the process exits cleanly before the timeout", async () => {
    vi.useFakeTimers();
    const signals: string[] = [];
    mocks.execFile.mockImplementation((_cmd, _args, _options, cb) => {
      // Deferred, like real execFile: it never invokes its callback
      // synchronously, so the caller's own local `const`s (the timers,
      // declared after this call returns) are always initialized by the
      // time the callback runs.
      queueMicrotask(() => cb(null, "clean output", ""));
      return { kill: (signal: string) => signals.push(signal) };
    });

    await expect(git("/fake/repo", "status")).resolves.toBe("clean output");
    await vi.advanceTimersByTimeAsync(35_000);
    expect(signals).toEqual([]);
  });
});
