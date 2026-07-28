import { EventEmitter } from "node:events";
import { db, events, now } from "@/db";

export type RalphEvent = {
  id: number;
  cardId: string | null;
  runId: string | null;
  type: string;
  payload: string;
  createdAt: string;
};

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
