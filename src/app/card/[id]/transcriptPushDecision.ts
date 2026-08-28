/**
 * PLAN.md Phase 18.3 — decide what to do with an incoming transcript SSE
 * push given the client's current cursor.
 *
 * The server-side watcher (`startTranscriptPush`, src/server/transcript.ts)
 * keeps its own cursor, independent of whatever cursor the client's own
 * fetch loop has reached, and reads at most `TRANSCRIPT_CHUNK_BYTES` per
 * `fs.watch` event — it can legitimately trail behind a client that has
 * already drained to EOF itself. A push's `lines` batch is only safe to
 * append directly when it starts exactly where the client's cursor already
 * is (`fromCursor === currentCursor`); anything else — an overlap
 * (`fromCursor < currentCursor`, which would render duplicate lines on a
 * naive append) or a gap (`fromCursor > currentCursor`, not expected per the
 * analysis in PLAN.md but not assumed impossible either) — must fall back to
 * an authoritative cursor-based resync fetch instead of guessing at a byte
 * range.
 */
export type TranscriptPushDecision = "ignore" | "resync" | "apply";

export function transcriptPushDecision(
  msg: { fromCursor?: number; cursor?: number },
  currentCursor: number,
  needsResync: boolean,
): TranscriptPushDecision {
  if (typeof msg.cursor !== "number" || msg.cursor <= currentCursor) return "ignore"; // stale/redundant
  // Not yet confirmed our cursor lines up with the watcher's own sequence —
  // resync via the authoritative cursor-based fetch rather than risk
  // double-counting (or missing) a byte range we can't yet trust.
  if (needsResync) return "resync";
  if (typeof msg.fromCursor !== "number" || msg.fromCursor !== currentCursor) return "resync";
  return "apply";
}
