import fs from "node:fs";
import path from "node:path";
import type { TranscriptEvent } from "./harness";
import { bus, type TranscriptPush } from "./events";

export const TRANSCRIPT_CHUNK_BYTES = 512 * 1024;

export type TranscriptChunk = {
  lines: TranscriptEvent[];
  cursor: number;
  hasMore: boolean;
  truncated: boolean;
  reset: boolean;
};

function parseLine(line: string): TranscriptEvent[] {
  // Every writer emits already-normalized, `t`-tagged TranscriptEvents (spec
  // 13 — the runner normalizes SDK events before writing). Anything untagged is
  // genuinely raw.
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed.t === "string") return [parsed as TranscriptEvent];
    return [{ t: "raw", line }];
  } catch {
    return [{ t: "raw", line }];
  }
}

/** Read one bounded JSONL chunk. The cursor advances only past complete lines,
 * so a writer's partial trailing line is retried on the next poll. */
export async function readTranscriptChunk(
  filePath: string,
  requestedCursor: number | null,
  running: boolean,
  maxBytes = TRANSCRIPT_CHUNK_BYTES,
): Promise<TranscriptChunk> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(/* turbopackIgnore: true */ filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lines: [], cursor: 0, hasMore: false, truncated: false, reset: false };
    }
    throw error;
  }

  try {
    const size = (await handle.stat()).size;
    const invalidCursor = requestedCursor !== null && requestedCursor > size;
    let start = requestedCursor === null ? Math.max(0, size - maxBytes) : requestedCursor;
    if (invalidCursor) start = 0;
    const truncated = requestedCursor === null && start > 0;
    const length = Math.min(maxBytes, Math.max(0, size - start));
    if (length === 0) {
      return { lines: [], cursor: start, hasMore: false, truncated, reset: invalidCursor };
    }

    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let content = buffer.subarray(0, bytesRead);
    let skippedPrefix = 0;
    if (truncated) {
      const firstNewline = content.indexOf(0x0a);
      if (firstNewline === -1) {
        return { lines: [], cursor: start + bytesRead, hasMore: start + bytesRead < size, truncated, reset: false };
      }
      skippedPrefix = firstNewline + 1;
      content = content.subarray(skippedPrefix);
    }

    const end = start + bytesRead;
    const lastNewline = content.lastIndexOf(0x0a);
    const canConsumeTrailingLine = !running && end >= size;
    const consumedContent = lastNewline >= 0
      ? content.subarray(0, lastNewline + 1)
      : canConsumeTrailingLine
        ? content
        : Buffer.alloc(0);
    const consumedBytes = skippedPrefix + consumedContent.byteLength;
    const cursor = start + consumedBytes;
    const lines = consumedContent
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap(parseLine);

    return {
      lines,
      cursor,
      hasMore: cursor < size && consumedBytes > 0,
      truncated,
      reset: invalidCursor,
    };
  } finally {
    await handle.close();
  }
}

/**
 * How often the pre-attach phase stats the transcript file, in ms. It is only
 * the backstop for a directory watch that could not be armed at all (see
 * `watchPendingDir`), so it never has to be the thing that notices the file:
 * while it was the only fallback — at 300 ms — a run or iteration that finished
 * before the first tick delivered no live transcript at all, which made
 * `make check-split` fail intermittently (card 2026-09-26).
 */
const TRANSCRIPT_APPEAR_POLL_MS = 50;

/**
 * The deepest directory above `filePath` that exists, or null when even the
 * filesystem root is missing.
 *
 * `fs.watch` needs a path that exists, and neither half of a run's transcript
 * path does when the web process arms its watcher: `runTranscriptDir(runId)` is
 * mkdir'd by the harness at the start of the first stage run for that run, and
 * the JSONL file itself only on that session's first write
 * (src/server/harness/index.ts). The watcher is started from `run.started` /
 * `iteration.started` (spec 25 decision 5), i.e. before either. The deepest
 * level that is already there does report the level below it appearing, so the
 * wait starts there and walks down — `fs.watch` is not recursive.
 */
function deepestExistingDir(filePath: string): string | null {
  let dir = path.dirname(filePath);
  for (;;) {
    if (fs.existsSync(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Tail `transcriptPath` for changes, invoking `onChange` on each one.
 * `fs.watch` needs the path to already exist, but the harness creates the
 * transcript file lazily on its first write (harness/index.ts:250-251) — a
 * watch started right as a run/iteration begins races that creation, and so it
 * races the run's transcript directory too. Fall back to a watch on the deepest
 * directory that exists yet, moved down as each missing level appears (see
 * `deepestExistingDir`), plus a `fs.watchFile` stat as the backstop for a watch
 * that could not be armed at all, and hand off to a real `fs.watch` once the
 * file is there. Either way, `onChange` is invoked once right after attaching so
 * anything already in the file is caught up on — the watcher may be started by a
 * process other than the writer (spec 25), so the file may already have content
 * by the time we attach. Returns a `close()`.
 */
function watchTranscript(transcriptPath: string, onChange: () => void): () => void {
  let closed = false;
  let watcher: fs.FSWatcher | null = null;
  // Stands in for the not-yet-existing file: its own directory when that exists,
  // otherwise the deepest ancestor that does.
  let pendingWatcher: fs.FSWatcher | null = null;
  let pendingDir: string | null = null;
  // A directory that refused the watch (permissions, or vanished between the
  // stat and the watch). The poll covers it, so don't retry once per tick.
  let pendingBroken = false;
  const attach = (): boolean => {
    try {
      // Guard against a stray event firing after stop() — close() isn't
      // guaranteed to suppress an already-queued callback.
      watcher = fs.watch(transcriptPath, () => {
        if (!closed) onChange();
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return false;
    }
  };
  const closePending = (): void => {
    pendingWatcher?.close();
    pendingWatcher = null;
    pendingDir = null;
  };
  /** Done waiting for the file: stop the pre-attach mechanisms. */
  const stopWaiting = (): void => {
    closePending();
    fs.unwatchFile(transcriptPath, poll);
  };
  /** The file showed up mid-race: attach to it for real, then catch up. */
  const appeared = (): void => {
    if (closed || watcher) return;
    const attachedNow = attach();
    if (attachedNow) stopWaiting();
    // Catch up either way. The watch/poll said the file is there and attach()
    // can still lose the race (or refuse to watch at all), and losing it must
    // not cost the run its transcript — an empty read costs nothing.
    onChange();
  };
  /** Arm the stand-in watch on the deepest existing directory. */
  const watchPendingDir = (): void => {
    if (closed || watcher || pendingWatcher || pendingBroken) return;
    const dir = deepestExistingDir(transcriptPath);
    if (!dir) return;
    pendingDir = dir;
    try {
      pendingWatcher = fs.watch(dir, () => {
        appeared();
        if (closed || watcher) return;
        // Still waiting on the file. If the writer created the next level down
        // since this watch was armed, only a watch on that one will report the
        // transcript file itself — move down.
        if (deepestExistingDir(transcriptPath) !== pendingDir) {
          closePending();
          watchPendingDir();
        }
      });
    } catch {
      closePending();
      pendingBroken = true;
    }
  };
  if (attach()) {
    onChange(); // catch up on anything written before we attached
    return () => {
      closed = true;
      watcher?.close();
    };
  }
  watchPendingDir();
  function poll(curr: fs.Stats): void {
    if (curr.mtimeMs === 0) return; // file still doesn't exist
    appeared();
  }
  fs.watchFile(transcriptPath, { interval: TRANSCRIPT_APPEAR_POLL_MS }, poll);
  return () => {
    closed = true;
    stopWaiting();
    watcher?.close();
  };
}

/**
 * Push new transcript lines over `bus`'s `"transcript"` channel as a run
 * writes them (Phase 16 chunk A) — a plain `bus.emit`, not `emitEvent`: see
 * `TranscriptPush`'s doc comment (src/server/events.ts) for why this must
 * never hit the `events` table. Every live-transcript writer (loop
 * iterations, planning, evaluation) shares this one function so the cursor
 * bookkeeping and SSE payload shape stay identical across all of them.
 *
 * Callers own the run/iteration lifecycle: start this when a run/iteration
 * begins writing `transcriptPath` (or, in a split web/worker deployment, when
 * the web process first observes the run as running — spec 25) and call the
 * returned `stop()` once the run settles, so a run's watcher never outlives
 * the file it's tailing. Attaching late is safe: the watcher catches up on
 * everything already in the file from cursor 0 as soon as it attaches, and
 * attaching BEFORE the file exists is safe too — see `watchTranscript`.
 *
 * `stop()` starts no new reads. The batch a read that was already in flight
 * picks up is still delivered: the events tailer can hand the watcher registry
 * `run.started` and `run.finished` in one batch (spec 25), and those lines are
 * already on disk — dropping them left a fast run with an empty live
 * transcript. Cursors stay gapless because the batches of one watcher are
 * serialised and each watcher owns one (run, iteration) transcript file.
 */
export function startTranscriptPush(transcriptPath: string, runId: string, iteration: number): () => void {
  let cursor = 0;
  let stopped = false;
  // Re-entrancy guard: fs.watch can fire more than once for a single write,
  // and the client trusts this channel's cursor sequence to be gapless and
  // non-overlapping once caught up — two overlapping `readTranscriptChunk`
  // calls sharing `cursor` would race and could emit duplicate line ranges.
  let pumpInFlight = false;
  let recheckPending = false;
  const pump = () => {
    // A stray fs event delivered after stop() starts no new read: the caller
    // owns this watcher's lifecycle, and `watchTranscript`'s close() is not
    // guaranteed to suppress an already-queued callback.
    if (stopped) return;
    if (pumpInFlight) {
      recheckPending = true;
      return;
    }
    pumpInFlight = true;
    const fromCursor = cursor;
    readTranscriptChunk(transcriptPath, cursor, true)
      .then((chunk) => {
        // stop() may have landed while this read was in flight — the events
        // tailer can hand the watcher registry `iteration.started` and
        // `run.finished` in one batch, so the watcher is stopped before its
        // catch-up read resolves. The lines it read are already on disk and
        // already paid for: emitting them is the watcher's last delivery
        // (`pump` returns early from then on, see the `stopped` guard above),
        // and dropping them is what left a fast run with an empty live
        // transcript. Cursors stay gapless because this watcher is the only
        // writer of its (runId, iteration) ranges.
        // More complete lines remain past this chunk: read them right away
        // instead of waiting for another fs event that may never come.
        if (chunk.hasMore) recheckPending = true;
        if (chunk.lines.length === 0) return;
        cursor = chunk.cursor;
        const push: TranscriptPush = {
          runId,
          iteration,
          fromCursor,
          cursor: chunk.cursor,
          lines: chunk.lines,
        };
        bus.emit("transcript", push);
      })
      .catch(() => {
        // Best-effort live tail; the JSONL file itself remains the durable
        // copy, so a transient read failure here just means this batch of
        // lines shows up on the next fs event instead.
      })
      .finally(() => {
        pumpInFlight = false;
        if (recheckPending) {
          recheckPending = false;
          if (!stopped) pump();
        }
      });
  };
  const close = watchTranscript(transcriptPath, pump);
  return () => {
    stopped = true;
    close();
  };
}
