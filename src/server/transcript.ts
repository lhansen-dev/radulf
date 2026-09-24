import fs from "node:fs";
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
 * Tail `transcriptPath` for changes, invoking `onChange` on each one.
 * `fs.watch` needs the path to already exist, but the harness creates the
 * transcript file lazily on its first write (harness/index.ts:250-251) — a
 * watch started right as a run/iteration begins races that creation. Fall
 * back to a short `fs.watchFile` poll until the file appears, then hand off
 * to a real `fs.watch` for genuine push behavior. Either way, `onChange` is
 * invoked once right after attaching so anything already in the file is
 * caught up on — the watcher may be started by a process other than the
 * writer (spec 25), so the file may already have content by the time we
 * attach. Returns a `close()`.
 */
function watchTranscript(transcriptPath: string, onChange: () => void): () => void {
  let closed = false;
  let watcher: fs.FSWatcher | null = null;
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
  if (attach()) {
    onChange(); // catch up on anything written before we attached
    return () => {
      closed = true;
      watcher?.close();
    };
  }
  const poll = (curr: fs.Stats) => {
    if (curr.mtimeMs === 0) return; // file still doesn't exist
    fs.unwatchFile(transcriptPath, poll);
    if (closed) return;
    attach();
    onChange(); // catch up on anything written before we attached
  };
  fs.watchFile(transcriptPath, { interval: 300 }, poll);
  return () => {
    closed = true;
    fs.unwatchFile(transcriptPath, poll);
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
 * everything already in the file from cursor 0 as soon as it attaches, and a
 * read still in flight when `stop()` is called emits nothing.
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
    if (pumpInFlight) {
      recheckPending = true;
      return;
    }
    pumpInFlight = true;
    const fromCursor = cursor;
    readTranscriptChunk(transcriptPath, cursor, true)
      .then((chunk) => {
        // stop() may have landed while the read was in flight (e.g. the
        // catch-up pump fired by attaching) — emit nothing and leave the
        // cursor alone.
        if (stopped) return;
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
