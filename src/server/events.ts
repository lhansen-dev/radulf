import { EventEmitter } from "node:events";
import { db, events, now } from "@/db";
import type { TranscriptEvent } from "./harness";

export type RalphEvent = {
  id: number;
  cardId: string | null;
  runId: string | null;
  type: string;
  payload: string;
  createdAt: string;
};

/** Payload for the `bus`'s `"transcript"` channel (Phase 16 chunk A) — a
 * plain in-memory push of newly-written transcript lines while a run (loop
 * iteration, planning, or evaluation) is live. `iteration` is the loop
 * iteration number, or `0` for the single-file plan/evaluate transcripts.
 * Deliberately NOT an `emitEvent`/`RalphEvent`: a chatty iteration can
 * produce hundreds of these a second, and `emitEvent` writes every event to
 * the `events` table permanently. The JSONL file on disk is already the
 * durable copy, so this only ever needs to reach a connected browser, never
 * SQLite. */
export type TranscriptPush = {
  runId: string;
  iteration: number;
  /** The byte offset `lines` actually starts at (the watcher's cursor right
   * before this batch's `readTranscriptChunk` call) — lets the client detect
   * a push that overlaps data it already applied (PLAN.md Phase 18.3: the
   * watcher's own cursor can legitimately trail the client's, since it reads
   * at most TRANSCRIPT_CHUNK_BYTES per `fs.watch` event while the client
   * drains to EOF itself) and fall back to a resync fetch instead of
   * double-applying the overlapping prefix. */
  fromCursor: number;
  cursor: number;
  lines: TranscriptEvent[];
};

// globalThis-backed for the same reason as the orchestrator singleton
// (src/server/orchestrator.ts:1128): survive Next.js dev hot-reload, one bus
// per process. Same hazard applies to anything crossing this bus — a custom
// class `instanceof` check is unreliable if the checking module and the
// throwing/emitting module ended up in different bundler module graphs.
const g = globalThis as unknown as { __radulfBus?: EventEmitter };
export const bus = (g.__radulfBus ??= new EventEmitter().setMaxListeners(100));

export function emitEvent(
  type: string,
  opts: { cardId?: string; runId?: string; payload?: Record<string, unknown> } = {}
) {
  const row = db
    .insert(events)
    .values({
      cardId: opts.cardId ?? null,
      runId: opts.runId ?? null,
      type,
      payload: JSON.stringify(opts.payload ?? {}),
      createdAt: now(),
    })
    .returning()
    .get();
  bus.emit("event", row as RalphEvent);
  return row;
}
