import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db, runs } from "@/db";
import { FAILED_RUN_STATUSES } from "@/shared/failedStep";
import { runTranscriptDir } from "./retention";
import type { TranscriptEvent } from "./harness";

/**
 * Spec 26: a planner or evaluator retry inherits the attempt it retries.
 *
 * A retry used to be byte-identical to the attempt that failed: the partial
 * verdict was deleted, the prompt was rendered from the same inputs, and the
 * failed run's transcript was read by nothing but the UI. On the first spec 25
 * piece the second evaluator attempt repeated the first one's forty tool calls
 * from the top and timed out the same way. Everything below is built from
 * what already exists on disk, the JSONL transcript and the `.ralph/` files,
 * and is bounded so prompt growth stays under control (spec 18 item 9).
 */

export type AttemptStage = "planner" | "evaluator" | "critic";

export type PreviousAttempt = {
  runId: string;
  kind: "plan" | "evaluate";
  status: string;
  exitReason: string | null;
  startedAt: string;
  endedAt: string | null;
};

export type DigestCommand = {
  name: string;
  /** The command line, path, or pattern the tool was called with. */
  summary: string;
  /** The tail of the tool's output, "" when the transcript holds none. */
  output: string;
  isError: boolean;
};

export type AttemptDigest = {
  lastText: string;
  commands: DigestCommand[];
  /** Every tool call the attempt made, including ones the digest dropped. */
  toolCalls: number;
};

/** The evaluator's running log, kept across attempts of one evaluation cycle. */
export const EVALUATION_NOTES_FILE = "EVALUATION-NOTES.md";

/** The digest keeps this many of the attempt's last commands. */
export const DIGEST_MAX_COMMANDS = 40;
/** And this much of each command's output, from the end. */
export const DIGEST_OUTPUT_CHARS = 400;
const DIGEST_SUMMARY_CHARS = 200;
const LAST_TEXT_CHARS = 1_500;
const NOTES_CHARS = 6_000;
const DRAFT_CHARS = 4_000;
/** The whole previous-attempt section, after which the oldest commands go. */
export const SECTION_MAX_CHARS = 20_000;

/**
 * The failed attempt a new `kind` run is retrying: the card's most recent run
 * is of that kind and ended failed, timed out, or interrupted. Anything else
 * (a completed run, or a loop run, which means a fresh cycle) yields null.
 * Call it before inserting the new run's row.
 */
export function previousFailedAttempt(cardId: string, kind: PreviousAttempt["kind"]): PreviousAttempt | null {
  const latest = db
    .select()
    .from(runs)
    .where(eq(runs.cardId, cardId))
    .orderBy(desc(runs.startedAt))
    .limit(1)
    .get();
  if (!latest || latest.kind !== kind || !FAILED_RUN_STATUSES.has(latest.status)) return null;
  return {
    runId: latest.id,
    kind,
    status: latest.status,
    exitReason: latest.exitReason ?? null,
    startedAt: latest.startedAt,
    endedAt: latest.endedAt ?? null,
  };
}

/** Where a plan or evaluate run's transcript lives. */
export function attemptTranscriptPath(attempt: PreviousAttempt): string {
  return path.join(runTranscriptDir(attempt.runId), attempt.kind === "plan" ? "plan.jsonl" : "evaluate.jsonl");
}

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : `…${text.slice(text.length - chars)}`;
}

function head(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars)}…`;
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "path", "pattern", "query"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

/** The text of a pi `tool_execution_end` result, whatever shape it took. */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : ""))
    .join("");
}

/**
 * Fold a transcript into the digest. Tool calls are the normalized `tool`
 * events; their outputs are the raw `tool_execution_end` events pi emits, in
 * the same order, so the n-th end belongs to the n-th call. A missing or
 * unreadable transcript gives an empty digest rather than an error: the
 * section still tells the retry how the attempt ended.
 */
export function digestTranscript(transcriptPath: string): AttemptDigest {
  let raw = "";
  try {
    raw = fs.readFileSync(/* turbopackIgnore: true */ transcriptPath, "utf8");
  } catch {
    return { lastText: "", commands: [], toolCalls: 0 };
  }
  const commands: DigestCommand[] = [];
  let lastText = "";
  let nextOutput = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: TranscriptEvent;
    try {
      event = JSON.parse(line) as TranscriptEvent;
    } catch {
      continue;
    }
    if (event.t === "text") {
      lastText = event.content;
    } else if (event.t === "tool") {
      commands.push({
        name: event.name,
        summary: head(summarizeInput(event.input).replace(/\s+/g, " ").trim(), DIGEST_SUMMARY_CHARS),
        output: "",
        isError: false,
      });
    } else if (event.t === "raw" && "event" in event && event.event && typeof event.event === "object") {
      const piEvent = event.event as { type?: unknown; result?: unknown; isError?: unknown };
      if (piEvent.type !== "tool_execution_end") continue;
      const command = commands[nextOutput++];
      if (!command) continue;
      command.output = tail(resultText(piEvent.result).trimEnd(), DIGEST_OUTPUT_CHARS);
      command.isError = piEvent.isError === true;
    }
  }
  return {
    lastText: head(lastText, LAST_TEXT_CHARS),
    commands: commands.slice(-DIGEST_MAX_COMMANDS),
    toolCalls: commands.length,
  };
}

function elapsedMinutes(attempt: PreviousAttempt): number | null {
  if (!attempt.endedAt) return null;
  const ms = Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 60_000) : null;
}

function describeEnding(attempt: PreviousAttempt): string {
  const minutes = elapsedMinutes(attempt);
  const after = minutes === null ? "" : ` after ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const reason = attempt.exitReason?.trim() || attempt.status;
  return `${reason}${after}`;
}

function renderCommands(commands: DigestCommand[], dropped: number): string {
  if (commands.length === 0) return "(the transcript records no tool calls)\n";
  const lines: string[] = [];
  if (dropped > 0) lines.push(`(${dropped} earlier command${dropped === 1 ? "" : "s"} omitted)`);
  commands.forEach((command, index) => {
    const n = dropped + index + 1;
    lines.push(`${n}. ${command.name}: ${command.summary}${command.isError ? "  [error]" : ""}`);
    if (command.output) {
      lines.push(...command.output.split("\n").map((l) => `     ${l}`));
    }
  });
  return `${lines.join("\n")}\n`;
}

export type PreviousAttemptInput = {
  stage: AttemptStage;
  attempt: PreviousAttempt;
  digest: AttemptDigest;
  /** The evaluator's running notes, forwarded verbatim. */
  notes?: string;
  /** The planner's draft artifacts left by the killed attempt, by file name. */
  drafts?: Record<string, string>;
};

/**
 * The section a retry reads before anything else about its predecessor. It
 * is explicit that this is a killed attempt's material: reuse what passed,
 * re-check what is inconclusive, do not replay the whole sequence.
 */
export function renderPreviousAttemptSection(input: PreviousAttemptInput): string {
  const { stage, attempt, notes, drafts } = input;
  let digest = input.digest;
  const build = () => {
    const dropped = digest.toolCalls - digest.commands.length;
    const parts = [
      "PREVIOUS ATTEMPT OF THIS STAGE",
      "==============================",
      `The last ${stage} attempt on this card ended with: ${describeEnding(attempt)}.`,
      `It made ${digest.toolCalls} tool call${digest.toolCalls === 1 ? "" : "s"}. What follows was recovered from`,
      "that killed attempt. Reuse the results that clearly passed, re-check anything",
      "inconclusive, and do not repeat the whole sequence from the top.",
      "",
    ];
    if (notes?.trim()) {
      parts.push("Its running notes (.ralph/EVALUATION-NOTES.md):", tail(notes.trim(), NOTES_CHARS), "");
    }
    if (drafts) {
      for (const [name, content] of Object.entries(drafts)) {
        if (!content.trim()) continue;
        parts.push(`Its draft .ralph/${name}, incomplete and unverified:`, head(content.trim(), DRAFT_CHARS), "");
      }
    }
    if (digest.lastText.trim()) {
      parts.push("Its last words:", digest.lastText.trim(), "");
    }
    parts.push("Commands it ran, with the end of each output:", renderCommands(digest.commands, dropped));
    return `\n${parts.join("\n")}`;
  };
  let section = build();
  while (section.length > SECTION_MAX_CHARS && digest.commands.length > 0) {
    digest = { ...digest, commands: digest.commands.slice(1) };
    section = build();
  }
  return section;
}

/**
 * The clock the watchdog reads, put where the model can see it. A hard
 * timeout with nothing on disk is the worst outcome of a stage, and the model
 * cannot tell it is near one otherwise.
 */
export function renderDeadlineSection(stage: AttemptStage, startedAt: Date, budgetMs: number): string {
  const minutes = Math.round(budgetMs / 60_000);
  const deadline = new Date(startedAt.getTime() + budgetMs);
  const target = new Date(startedAt.getTime() + budgetMs * 0.7);
  const deliverable =
    stage === "evaluator"
      ? "your verdict in `.ralph/EVALUATION.md`"
      : stage === "critic"
        ? "your verdict in `.ralph/CRITIQUE.md`"
        : "the three plan artifacts in `.ralph/`";
  return (
    "\nATTEMPT BUDGET\n==============\n" +
    `This attempt started at ${startedAt.toISOString()}. Its hard budget is ${minutes} minute${minutes === 1 ? "" : "s"}: ` +
    `at ${deadline.toISOString()} it is killed and whatever is not on disk is lost. ` +
    `Have ${deliverable} written by ${target.toISOString()}, and check the clock with \`date -u\` ` +
    "when a step runs long.\n"
  );
}

/** The evaluator's running log protocol, appended outside the template so a
 * customized template still gets it. */
export const EVALUATION_NOTES_SECTION =
  "\nRUNNING NOTES\n=============\n" +
  `Keep \`.ralph/${EVALUATION_NOTES_FILE}\` current as you work: after each check, append one ` +
  "line naming the command and its outcome. The file survives if this attempt is killed and is " +
  "handed to the next attempt, so it is how verification stops being lost. It is a permitted " +
  "writable output.\n";
