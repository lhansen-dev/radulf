"use client";
import { useState } from "react";
import { useEventStream } from "./api";
import { describeToolCall } from "./toolDescription";

/** A transcript line as the live push carries it: a TranscriptEvent
 * (src/server/harness/types.ts), of which this reads only these fields. */
type PushLine = { t?: string; name?: string; input?: unknown };

/**
 * One short line saying what a transcript event shows the model doing, or
 * null for an event that says nothing about that: usage, results, and the
 * raw framing the transcript view does not draw either.
 */
export function describeTranscriptLine(line: PushLine): string | null {
  switch (line.t) {
    case "tool": {
      const name = String(line.name ?? "");
      const detail = describeToolCall(name, line.input);
      return detail ? `${name} ${detail}` : name || null;
    }
    case "reasoning":
      return "Thinking";
    case "text":
      return "Writing";
    default:
      return null;
  }
}

export type RunActivity = {
  /** When the last push for this run arrived, or null before the first. */
  lastAt: number | null;
  /** What that push showed the model doing, when any push has shown anything. */
  label: string | null;
};

const IDLE: RunActivity = { lastAt: null, label: null };

/**
 * What a live run was last seen doing, from the transcript pushes the shared
 * event stream carries for `runId` (TranscriptPush in src/server/events.ts).
 * Every push counts as activity, even one whose lines describe nothing, so
 * `lastAt` answers "is it still going" while `label` answers "doing what".
 * Pointed at a different run, it reads as idle until that run's first push.
 */
export function useRunActivity(runId: string | null): RunActivity {
  const [seen, setSeen] = useState<RunActivity & { runId: string | null }>({ ...IDLE, runId: null });
  useEventStream((raw) => {
    if (!runId) return;
    const msg = raw as unknown as { kind?: string; runId?: string; lines?: PushLine[] };
    if (msg.kind !== "transcript" || msg.runId !== runId) return;
    const label =
      (msg.lines ?? [])
        .map(describeTranscriptLine)
        .filter((line): line is string => line !== null)
        .at(-1) ?? null;
    setSeen((prev) => ({
      runId,
      lastAt: Date.now(),
      label: label ?? (prev.runId === runId ? prev.label : null),
    }));
  });
  const { runId: seenFor, ...activity } = seen;
  return seenFor === runId ? activity : IDLE;
}
