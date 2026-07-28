import fs from "node:fs";
import type { TranscriptEvent } from "./harness";

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
