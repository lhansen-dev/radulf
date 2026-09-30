import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bus, type TranscriptPush } from "./events";
import { readTranscriptChunk, startTranscriptPush } from "./transcript";

/** Wait for the next `"transcript"` push matching `runId`. The trigger
 * (fs.watch/watchFile) is mocked in the tests below so this only waits on
 * `readTranscriptChunk`'s own real (but fast, non-timer) file read — no OS
 * poll-interval timing involved. */
function nextTranscriptPush(runId: string, timeoutMs = 2_000): Promise<TranscriptPush> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.off("transcript", onPush);
      reject(new Error(`no transcript push for ${runId} within ${timeoutMs}ms`));
    }, timeoutMs);
    const onPush = (push: TranscriptPush) => {
      if (push.runId !== runId) return;
      clearTimeout(timer);
      bus.off("transcript", onPush);
      resolve(push);
    };
    bus.on("transcript", onPush);
  });
}

describe("readTranscriptChunk", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-transcript-"));
    file = path.join(dir, "transcript.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("advances through bounded chunks without repeating events", async () => {
    const expected = Array.from({ length: 5 }, (_, index) => ({
      t: "text",
      role: "assistant",
      content: `event-${index}`,
    }));
    fs.writeFileSync(file, expected.map((event) => JSON.stringify(event)).join("\n") + "\n");

    let cursor = 0;
    const actual: unknown[] = [];
    do {
      const chunk = await readTranscriptChunk(file, cursor, false, 80);
      actual.push(...chunk.lines);
      expect(chunk.cursor).toBeGreaterThan(cursor);
      cursor = chunk.cursor;
      if (!chunk.hasMore) break;
    } while (true);

    expect(actual).toEqual(expected);
    expect(cursor).toBe(fs.statSync(file).size);
  });

  it("does not consume a live writer's partial trailing line", async () => {
    const first = JSON.stringify({ t: "text", role: "assistant", content: "first" });
    const second = JSON.stringify({ t: "text", role: "assistant", content: "second" });
    fs.writeFileSync(file, `${first}\n${second.slice(0, 20)}`);

    const initial = await readTranscriptChunk(file, 0, true);
    expect(initial.lines).toEqual([{ t: "text", role: "assistant", content: "first" }]);
    const waiting = await readTranscriptChunk(file, initial.cursor, true);
    expect(waiting.lines).toEqual([]);
    expect(waiting.cursor).toBe(initial.cursor);

    fs.appendFileSync(file, `${second.slice(20)}\n`);
    const completed = await readTranscriptChunk(file, initial.cursor, true);
    expect(completed.lines).toEqual([{ t: "text", role: "assistant", content: "second" }]);
    expect(completed.cursor).toBe(fs.statSync(file).size);
  });

  it("tails a bounded window when no cursor is supplied", async () => {
    const events = Array.from({ length: 20 }, (_, index) => ({
      t: "raw",
      line: `line-${String(index).padStart(2, "0")}`,
    }));
    fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");

    const chunk = await readTranscriptChunk(file, null, false, 150);

    expect(chunk.truncated).toBe(true);
    expect(chunk.lines.length).toBeGreaterThan(0);
    expect(chunk.lines.at(-1)).toEqual(events.at(-1));
    expect(chunk.cursor).toBe(fs.statSync(file).size);
  });

  it("returns an empty chunk for a transcript that does not exist yet", async () => {
    await expect(readTranscriptChunk(file, 0, true)).resolves.toEqual({
      lines: [],
      cursor: 0,
      hasMore: false,
      truncated: false,
      reset: false,
    });
  });
});

// `fs.watch`/`fs.watchFile` are mocked throughout this suite: the real OS
// notification/poll timing is what's flaky to depend on in a shared/loaded
// test runner (proven independently — a bare `fs.watch` smoke test times
// out under the full suite's parallelism but never in isolation), and it's
// not what this code actually needs to prove correct. What matters is the
// *logic* around whichever fs primitive fires: ENOENT handling, cursor
// bookkeeping via the real (fast, non-timer) `readTranscriptChunk`, and
// stop() actually silencing further pushes. Each test drives that logic by
// invoking the captured watch/poll callback directly.
describe("startTranscriptPush", () => {
  let dir: string;
  let file: string;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-transcript-push-"));
    file = path.join(dir, "transcript.jsonl");
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pushes lines when fs.watch reports a change on an existing file", async () => {
    fs.writeFileSync(file, "");
    let watchCallback: (() => void) | undefined;
    vi.spyOn(fs, "watch").mockImplementation(((_path: unknown, cb: () => void) => {
      watchCallback = cb;
      return { close: vi.fn() } as unknown as fs.FSWatcher;
    }) as typeof fs.watch);

    stop = startTranscriptPush(file, "run-a", 3);
    expect(watchCallback).toBeDefined();

    const pending = nextTranscriptPush("run-a");
    fs.appendFileSync(file, `${JSON.stringify({ t: "text", content: "hello" })}\n`);
    watchCallback!();
    const push = await pending;

    expect(push.iteration).toBe(3);
    expect(push.lines).toEqual([{ t: "text", content: "hello" }]);
    expect(push.cursor).toBe(fs.statSync(file).size);
    expect(push.fromCursor).toBe(0); // PLAN.md Phase 18.3: 0 on the first pump
  });

  // Spec 25: in a split web/worker deployment the web process starts the
  // watcher when it first sees the run as running, which may be well after
  // the worker began writing. Attaching must catch up on what's already
  // there without waiting for a further fs event.
  it("catches up on lines written before the watcher attached, without a watch event", async () => {
    fs.writeFileSync(file, `${JSON.stringify({ t: "raw", line: "before-attach" })}\n`);
    let watchCallback: (() => void) | undefined;
    vi.spyOn(fs, "watch").mockImplementation(((_path: unknown, cb: () => void) => {
      watchCallback = cb;
      return { close: vi.fn() } as unknown as fs.FSWatcher;
    }) as typeof fs.watch);

    const pending = nextTranscriptPush("run-late");
    stop = startTranscriptPush(file, "run-late", 1);
    expect(watchCallback).toBeDefined();

    // Deliberately never invoke watchCallback: the attach itself must pump.
    const push = await pending;
    expect(push.fromCursor).toBe(0);
    expect(push.lines).toEqual([{ t: "raw", line: "before-attach" }]);
    expect(push.cursor).toBe(fs.statSync(file).size);
  });

  // PLAN.md Phase 18.3: fromCursor is the byte offset THIS batch started at
  // (the watcher's cursor before the pump's readTranscriptChunk call), so a
  // client that applied every prior push can tell a clean handoff (its own
  // cursor === this push's fromCursor) apart from an overlapping/gapped one.
  it("fromCursor across multiple pumps equals the previous pump's end cursor", async () => {
    fs.writeFileSync(file, "");
    let watchCallback: (() => void) | undefined;
    vi.spyOn(fs, "watch").mockImplementation(((_path: unknown, cb: () => void) => {
      watchCallback = cb;
      return { close: vi.fn() } as unknown as fs.FSWatcher;
    }) as typeof fs.watch);

    stop = startTranscriptPush(file, "run-fromcursor", 1);
    expect(watchCallback).toBeDefined();

    const firstPending = nextTranscriptPush("run-fromcursor");
    fs.appendFileSync(file, `${JSON.stringify({ t: "raw", line: "one" })}\n`);
    watchCallback!();
    const first = await firstPending;
    expect(first.fromCursor).toBe(0);
    expect(first.cursor).toBe(fs.statSync(file).size);

    const secondPending = nextTranscriptPush("run-fromcursor");
    fs.appendFileSync(file, `${JSON.stringify({ t: "raw", line: "two" })}\n`);
    watchCallback!();
    const second = await secondPending;
    // Clean handoff: the second pump picks up exactly where the first left off.
    expect(second.fromCursor).toBe(first.cursor);
    expect(second.cursor).toBe(fs.statSync(file).size);
  });

  it("falls back to watchFile on ENOENT, then delivers everything written before the catch-up", async () => {
    vi.spyOn(fs, "watch").mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    let pollCallback: ((curr: fs.Stats) => void) | undefined;
    vi.spyOn(fs, "watchFile").mockImplementation(((_path: unknown, _opts: unknown, cb: (curr: fs.Stats) => void) => {
      pollCallback = cb;
    }) as unknown as typeof fs.watchFile);
    vi.spyOn(fs, "unwatchFile").mockImplementation(() => fs);

    stop = startTranscriptPush(file, "run-b", 1);
    expect(pollCallback).toBeDefined();

    // Two lines land before the (mocked) poll ever ticks — proves the
    // catch-up read isn't dropping or duplicating anything across multiple
    // writes that happen to coalesce into one fs event.
    fs.writeFileSync(file, `${JSON.stringify({ t: "raw", line: "one" })}\n`);
    fs.appendFileSync(file, `${JSON.stringify({ t: "raw", line: "two" })}\n`);

    const pending = nextTranscriptPush("run-b");
    pollCallback!({ mtimeMs: Date.now() } as fs.Stats); // simulate "file appeared"
    const push = await pending;

    expect(push.lines).toEqual([{ t: "raw", line: "one" }, { t: "raw", line: "two" }]);
    expect(push.cursor).toBe(fs.statSync(file).size);
  });

  it("ignores a poll tick while the file still doesn't exist", () => {
    vi.spyOn(fs, "watch").mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    let pollCallback: ((curr: fs.Stats) => void) | undefined;
    vi.spyOn(fs, "watchFile").mockImplementation(((_path: unknown, _opts: unknown, cb: (curr: fs.Stats) => void) => {
      pollCallback = cb;
    }) as unknown as typeof fs.watchFile);
    const unwatch = vi.spyOn(fs, "unwatchFile").mockImplementation(() => fs);

    stop = startTranscriptPush(file, "run-x", 1);
    pollCallback!({ mtimeMs: 0 } as fs.Stats); // still doesn't exist

    expect(unwatch).not.toHaveBeenCalled();
  });

  it("stops pushing once stop() is called, even if the watch callback still fires", async () => {
    let watchCallback: (() => void) | undefined;
    const close = vi.fn();
    vi.spyOn(fs, "watch").mockImplementation(((_path: unknown, cb: () => void) => {
      watchCallback = cb;
      return { close } as unknown as fs.FSWatcher;
    }) as typeof fs.watch);
    fs.writeFileSync(file, "");

    const stopFn = startTranscriptPush(file, "run-c", 1);
    stop = stopFn;
    // Let the catch-up read fired by attaching settle before stopping. A batch
    // already in flight when stop() lands is still delivered (the "delivers the
    // batch already being read when stop() lands" test below) — what stop()
    // forbids is any NEW read, which is what this test pins down.
    await new Promise((resolve) => setTimeout(resolve, 10));
    stopFn();
    stop = null;
    expect(close).toHaveBeenCalledOnce();

    let sawPush = false;
    const onPush = (push: TranscriptPush) => {
      if (push.runId === "run-c") sawPush = true;
    };
    bus.on("transcript", onPush);
    fs.appendFileSync(file, `${JSON.stringify({ t: "raw", line: "after-stop" })}\n`);
    watchCallback!(); // a stray event delivered after close() — must be a no-op
    await new Promise((resolve) => setTimeout(resolve, 50));
    bus.off("transcript", onPush);

    expect(sawPush).toBe(false);
  });

  // Spec 25: in a split deployment the web process attaches when it first sees
  // the run as running, which is essentially always BEFORE the harness has
  // created the file. Creation must therefore be noticed on the containing
  // directory's watch event: while the only fallback was a 300 ms stat poll, a
  // run or iteration shorter than one tick attached nothing and delivered no
  // live transcript at all — what made `make check-split` fail intermittently
  // (card 2026-09-25).
  it("attaches as soon as the directory reports the new file, without a poll tick", async () => {
    let dirCallback: (() => void) | undefined;
    vi.spyOn(fs, "watch").mockImplementation(((p: unknown, cb: () => void) => {
      if (p === file && !fs.existsSync(file)) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err; // fs.watch needs a path that exists
      }
      if (p !== file) dirCallback = cb; // the containing directory
      return { close: vi.fn() } as unknown as fs.FSWatcher;
    }) as typeof fs.watch);
    const pollOpts: unknown[] = [];
    vi.spyOn(fs, "watchFile").mockImplementation(((_p: unknown, opts: unknown) => {
      pollOpts.push(opts);
      return fs;
    }) as unknown as typeof fs.watchFile);

    stop = startTranscriptPush(file, "run-appear", 1);
    expect(dirCallback).toBeDefined();
    // The stat poll stays as the backstop for a run directory that doesn't
    // exist yet, and its interval is the worst-case delay before a run's first
    // line is pushed — so it has to stay small.
    expect((pollOpts[0] as { interval: number }).interval).toBeLessThanOrEqual(100);

    fs.writeFileSync(file, `${JSON.stringify({ t: "raw", line: "first" })}\n`);
    const pending = nextTranscriptPush("run-appear");
    dirCallback!(); // the writer created the file; no timer may have to tick
    const push = await pending;

    expect(push.iteration).toBe(1);
    expect(push.fromCursor).toBe(0);
    expect(push.lines).toEqual([{ t: "raw", line: "first" }]);
    expect(push.cursor).toBe(fs.statSync(file).size);
  });

  // The events tailer can hand the web process `iteration.started` and
  // `run.finished` in one batch, so the watcher is attached and stopped before
  // its catch-up read resolves. Those lines are already on disk: dropping them
  // left a fast run with an empty live transcript.
  it("delivers the batch already being read when stop() lands, then goes silent", async () => {
    fs.writeFileSync(file, `${JSON.stringify({ t: "raw", line: "one" })}\n`);
    let watchCallback: (() => void) | undefined;
    vi.spyOn(fs, "watch").mockImplementation(((_path: unknown, cb: () => void) => {
      watchCallback = cb;
      return { close: vi.fn() } as unknown as fs.FSWatcher;
    }) as typeof fs.watch);

    const pending = nextTranscriptPush("run-stop");
    const stopFn = startTranscriptPush(file, "run-stop", 1);
    stopFn(); // stopped while the catch-up read from attaching is still in flight
    stop = null;

    const push = await pending;
    expect(push.fromCursor).toBe(0);
    expect(push.lines).toEqual([{ t: "raw", line: "one" }]);

    // That batch is the last one: a stray fs event after stop() starts no new
    // read.
    const after: TranscriptPush[] = [];
    const onPush = (p: TranscriptPush) => {
      if (p.runId === "run-stop") after.push(p);
    };
    bus.on("transcript", onPush);
    fs.appendFileSync(file, `${JSON.stringify({ t: "raw", line: "two" })}\n`);
    watchCallback!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    bus.off("transcript", onPush);
    expect(after).toEqual([]);
  });

  // Spec 25, and the hot path in a split deployment: the web process arms the
  // watcher on `run.started`/`iteration.started`, while the worker creates the
  // run's transcript DIRECTORY (`runTranscriptDir`, at the first harness call)
  // and the JSONL file (at its first write) afterwards. So watching the file's
  // own directory isn't possible yet either — the watch starts on the deepest
  // level that exists and walks down. `make check-split` failed intermittently
  // while this case was left to the stat poll (card 2026-09-26).
  it("follows a transcript directory created after the watcher started, without a poll tick", async () => {
    const runDir = path.join(dir, "run-nested");
    const nested = path.join(runDir, "iter-001.jsonl");
    const watched: string[] = [];
    const realWatch = fs.watch;
    vi.spyOn(fs, "watch").mockImplementation(((p: unknown, cb: unknown) => {
      watched.push(String(p));
      return realWatch(p as fs.PathLike, cb as never);
    }) as typeof fs.watch);

    const pending = nextTranscriptPush("run-nested");
    stop = startTranscriptPush(nested, "run-nested", 1);
    // [0] is the attach attempt on the file itself, which is what fails here;
    // the stand-in watch then sits on `dir` — never on the missing `run-nested`
    // directory, which fs.watch would refuse outright.
    expect(watched).toEqual([nested, dir]);

    fs.mkdirSync(runDir, { recursive: true });
    // The ancestor's event has to be processed before the file is written, or
    // the attach succeeds from the ancestor's event and the walk-down never
    // happens. Poll for it: it is an fs event, but a slow machine must not make
    // this test red. macOS FSEvents can take over a second under a full suite.
    for (let i = 0; i < 300 && !watched.includes(runDir); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(watched).toContain(runDir); // the watch moved down a level

    const line = `${JSON.stringify({ t: "raw", line: "first" })}\n`;
    fs.writeFileSync(nested, line);
    const push = await pending;

    expect(push.iteration).toBe(1);
    expect(push.fromCursor).toBe(0);
    expect(push.lines).toEqual([{ t: "raw", line: "first" }]);
    expect(push.cursor).toBe(fs.statSync(nested).size);
  });
});
