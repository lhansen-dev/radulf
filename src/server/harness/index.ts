import fs from "node:fs";
import path from "node:path";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { ProviderId } from "../providers";
import type { RunSandboxContext } from "../sandbox/context";
import { getSettings, type Settings } from "../settings";
import {
  createRalphSession,
  harnessPackageVersion,
  piNormalize,
  type AgentRole,
} from "./pi";
import { StuckDetector } from "./stuckDetector";
import { withStreamLiveness } from "./streamLiveness";
import type { TranscriptEvent, HarnessId } from "./types";

/**
 * The slice of the pi AgentSession that runHarness drives. AgentSession
 * satisfies it structurally; the test seam supplies a fake with the same shape.
 */
export interface HarnessSession {
  subscribe(listener: (evt: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
}

// Re-export so callers only need to import from ./harness.
export type { TranscriptEvent, HarnessId } from "./types";
export {
  createRalphSession,
  piNormalize,
  harnessPackageVersion,
  omlxProviderConfig,
  getModelRuntime,
  piAgentDir,
  listAuthedModels,
} from "./pi";
export type { AgentRole } from "./pi";

/**
 * Result of one runner invocation — spec 11 Phase 0 telemetry: the folded
 * transcript totals plus the watchdog verdicts and harness identity.
 */
export type RunnerResult = TranscriptTotals & {
  code: number | null;
  timedOut: boolean;
  /** True when the invocation was killed by the stall watchdog: the harness
   * emitted nothing for `stallTimeoutMs` (hung provider stream, dropped
   * network, machine sleep). */
  stalled: boolean;
  /** True when the invocation was killed for repeating the exact same tool
   * call over and over within this iteration (see StuckDetector). */
  stuck: boolean;
  /** Wall-clock ms from session start to the first normalized (non-raw) event. */
  firstTokenMs: number | null;
  harness: HarnessId;
  harnessVersion: string | null;
};

/** Telemetry persisted per iteration and per `runs` row, in column order. */
export const TELEMETRY_KEYS = [
  "promptTokens", "completionTokens", "cachedInputTokens", "cacheWriteTokens",
  "reasoningTokens", "modelTurns", "toolCalls", "toolDurationMs", "firstTokenMs",
  "costUsd", "harness", "harnessVersion",
] as const;

/**
 * The telemetry persisted on a `runs` row: a plan or evaluate run writes its
 * single invocation's numbers (via runTelemetry() below); a loop run writes
 * the sum of its iterations. Every field is nullable — unlike RunnerResult,
 * a roll-up over zero or partial iterations can lack any fact, and an
 * unreported fact is never coerced to zero.
 */
export type RunTelemetry = {
  [K in (typeof TELEMETRY_KEYS)[number]]: K extends "harness" | "harnessVersion"
    ? string | null
    : number | null;
};

/** Project a RunnerResult down to the RunTelemetry persisted on a `runs` row. */
export function runTelemetry(result: RunnerResult): RunTelemetry {
  return Object.fromEntries(TELEMETRY_KEYS.map((key) => [key, result[key]])) as RunTelemetry;
}

/**
 * Streaming accumulator for normalized transcript events — the single place
 * that turns per-turn usage/tool events into invocation totals, exported so
 * unit tests can drive it with pinned fixtures.
 *
 * Token fields sum per-model-turn usage events; a field is null when the
 * harness never reported it (unavailable stays unavailable — never coerced
 * to zero).
 */
export type TranscriptTotals = {
  /** Last assistant text seen in the stream — used as the iteration summary. */
  lastText: string;
  /** Error text from the result event, if any. */
  error: string;
  /** UNCACHED cumulative input tokens summed across every model turn — kept
   * under the historical name for migration compatibility. Not a context
   * size, and cache reads are excluded. */
  promptTokens: number;
  /** Completion tokens summed across every model turn. */
  completionTokens: number;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  /** Count of per-turn usage events (a cumulative-only harness yields 1),
   * overridden by a harness-reported turn count on the result event. */
  modelTurns: number | null;
  toolCalls: number;
  /** Summed harness-reported tool execution time; null when never reported. */
  toolDurationMs: number | null;
};

export function createTranscriptTotals(): TranscriptTotals {
  return {
    lastText: "",
    error: "",
    promptTokens: 0,
    completionTokens: 0,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: null,
    modelTurns: null,
    toolCalls: 0,
    toolDurationMs: null,
  };
}

/** Add a value the harness reported to a total that stays null until the
 * first report; an unreported value leaves the total untouched. */
function addReported(total: number | null, reported: number | undefined): number | null {
  return reported === undefined ? total : (total ?? 0) + reported;
}

export function foldTranscriptEvent(totals: TranscriptTotals, event: TranscriptEvent): void {
  if (event.t === "text") {
    totals.lastText = event.content;
  } else if (event.t === "tool") {
    totals.toolCalls += 1;
    totals.toolDurationMs = addReported(totals.toolDurationMs, event.durationMs);
  } else if (event.t === "usage") {
    // Every usage event is one model turn (pi emits one assistant message_end
    // per turn) — counting them can never double-count.
    totals.modelTurns = (totals.modelTurns ?? 0) + 1;
    totals.promptTokens += event.inputTokens;
    totals.completionTokens += event.outputTokens;
    totals.cachedInputTokens = addReported(totals.cachedInputTokens, event.cachedInputTokens);
    totals.cacheWriteTokens = addReported(totals.cacheWriteTokens, event.cacheWriteTokens);
    totals.reasoningTokens = addReported(totals.reasoningTokens, event.reasoningTokens);
    totals.costUsd = addReported(totals.costUsd, event.costUsd);
  } else if (event.t === "result") {
    if (event.exit === "failed") {
      totals.error = event.detail ?? "unknown error";
    } else {
      // A completed result after a failed one (pi's successful auto-retry)
      // supersedes it.
      totals.error = "";
    }
    if (event.numTurns !== undefined) {
      totals.modelTurns = event.numTurns;
    }
  }
}

/**
 * Most characters (text, thinking, and tool-call arguments combined) a single
 * assistant reply may stream before the invocation is aborted. Normal turns
 * are a few KB; a large file write is tens of KB. Past this the stream is
 * corrupt, not verbose — e.g. a provider re-sending the whole reply-so-far as
 * every delta, which once turned a 4k-token turn into 8.4 MB of text and
 * overflowed a 1M-token context on the next request.
 */
export const MAX_REPLY_CHARS = 1024 * 1024;

/** Why a watchdog aborted the session. The first cause to fire is the one
 * reported; a later one finds the session already aborting. */
type TripCause = "timeout" | "stalled" | "stuck" | "oversized" | "aborted";

type RunHarnessOpts = {
  provider: ProviderId;
  prompt: string;
  model: string;
  /** pi thinking level for this agent (off…max). Required so each caller passes
   * its own agent's configured level; now applied to every provider. */
  reasoningLevel: string;
  cwd: string;
  transcriptPath: string;
  timeoutMs: number;
  /** Kill the invocation when the harness emits no events for this long.
   * Omit — as every caller should — to use the `stallTimeoutSeconds` setting,
   * which is what makes the watchdog universal: a new call site gets stall
   * protection without opting in. Pass 0 to disable (tests only). */
  stallTimeoutMs?: number;
  signal?: AbortSignal;
  /** Pipeline role (spec 14) — decides the per-role tool set (planner gets
   * web_search but no bash; loop/evaluator get bash but no web_search). Each
   * pipeline entry point passes its own role. Omit for human-interactive,
   * non-pipeline sessions (chat, improvement proposer), which use `readOnly` instead. */
  role?: AgentRole;
  readOnly?: boolean;
  /** Per-run sandbox context (spec 14) — threaded into the pi session's bash
   * spawn hook. Created once per run by the entry point, cleaned up in its
   * finally. */
  runContext?: RunSandboxContext;
  /** Test seam — settings override. */
  settings?: Settings;
  /** Test seam — supply a session instead of constructing one via pi. */
  createSession?: () => Promise<HarnessSession>;
};

/**
 * Drive one in-process pi session, normalizing its event stream to
 * TranscriptEvent lines in the transcript file (spec 13). The three watchdogs
 * from the old subprocess runner survive, re-expressed for a promise: the
 * iteration timeout, the stall watchdog, and the external AbortSignal all fire
 * `session.abort()` and unblock via a watchdog race; `dispose()` in the finally
 * guarantees the session is released even if abort doesn't settle the prompt.
 */
export async function runHarness(opts: RunHarnessOpts): Promise<RunnerResult> {
  const totals = createTranscriptTotals();
  let firstTokenMs: number | null = null;
  // `as`: assigned from closures and read after them; a bare `= null` would
  // narrow it to null for the rest of the function.
  let tripped = null as TripCause | null;
  let replyChars = 0;
  const stuckDetector = new StuckDetector();
  const startedAtMs = Date.now();
  const version = harnessPackageVersion();

  fs.mkdirSync(path.dirname(opts.transcriptPath), { recursive: true });
  const out = fs.createWriteStream(opts.transcriptPath, { flags: "a" });
  // Resolve only once the transcript is flushed (or failed): a caller reads it
  // back as soon as this returns. end()'s callback also fires on error.
  const closeTranscript = () => new Promise<void>((resolve) => out.end(() => resolve()));

  const result = (code: number | null): RunnerResult => ({
    code,
    timedOut: tripped === "timeout",
    stalled: tripped === "stalled",
    stuck: tripped === "stuck",
    ...totals,
    firstTokenMs,
    harness: "pi",
    harnessVersion: version,
  });

  // One settings read per invocation, shared by session construction and the
  // stall watchdog. Lazy: a caller that supplies both `settings` and
  // `createSession` (unit tests) must never touch the DB.
  let settingsCache = opts.settings;
  const s = () => (settingsCache ??= getSettings());

  // Session construction can throw synchronously (blank OpenRouter/oMLX model,
  // no subscription login) — surface that as an error result.
  let session: HarnessSession;
  try {
    session = opts.createSession
      ? await opts.createSession()
      : await createRalphSession({
          provider: opts.provider,
          model: opts.model,
          reasoningLevel: opts.reasoningLevel,
          cwd: opts.cwd,
          role: opts.role,
          readOnly: opts.readOnly,
          runContext: opts.runContext,
          s: s(),
        });
  } catch (err) {
    await closeTranscript();
    totals.error = String(err instanceof Error ? err.message : err);
    return result(1);
  }

  // Watchdog race: any of the three triggers aborts the session and unblocks.
  let releaseWatchdog: () => void = () => {};
  const watchdog = new Promise<void>((res) => {
    releaseWatchdog = res;
  });
  const trip = (cause: TripCause) => {
    if (tripped !== null) return;
    tripped = cause;
    void session.abort().catch(() => {});
    releaseWatchdog();
  };

  const hardTimer = setTimeout(() => trip("timeout"), opts.timeoutMs);

  // Stall watchdog: any streamed event resets it — including the
  // `message_update` deltas piNormalize drops, so a model that is merely slow
  // (a long high-effort thinking block) keeps the timer alive. So does any
  // *byte* on the provider stream, via the liveness probe around the prompt
  // below: keep-alive traffic that never parses into an event (OpenRouter's
  // `: OPENROUTER PROCESSING` comments) counts as alive too. Only a stream
  // that hangs without erroring (network drop, machine sleep) trips it.
  // Defaulted from settings here rather than at the call sites so every model
  // call is covered; the floor keeps a mistyped setting from killing runs.
  const stallTimeoutMs =
    opts.stallTimeoutMs === undefined
      ? Math.max(30_000, s().stallTimeoutSeconds * 1000)
      : opts.stallTimeoutMs;
  // Activity is a timestamp, not a timer reset: every session event and every
  // SSE chunk notes it, and one timer, re-armed only when it fires, checks it.
  let lastActivityMs = Date.now();
  const noteActivity = () => {
    lastActivityMs = Date.now();
  };
  let stallTimer: NodeJS.Timeout | undefined;
  const armStallTimer = (delayMs: number) => {
    stallTimer = setTimeout(() => {
      const idleMs = Date.now() - lastActivityMs;
      if (idleMs >= stallTimeoutMs) trip("stalled");
      else armStallTimer(stallTimeoutMs - idleMs);
    }, delayMs);
  };
  if (stallTimeoutMs > 0) armStallTimer(stallTimeoutMs);

  const onAbort = () => trip("aborted");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const unsubscribe = session.subscribe((evt) => {
    noteActivity();
    // Reply-size guard: counted from the streaming deltas so the session is
    // aborted before an oversized reply lands in the context window.
    if (evt.type === "message_start" || evt.type === "message_end") {
      replyChars = 0;
    } else if (evt.type === "message_update") {
      const update = evt.assistantMessageEvent;
      if (
        update.type === "text_delta" ||
        update.type === "thinking_delta" ||
        update.type === "toolcall_delta"
      ) {
        replyChars += update.delta.length;
        if (replyChars > MAX_REPLY_CHARS) trip("oversized");
      }
    }
    for (const e of piNormalize(evt)) {
      out.write(JSON.stringify(e) + "\n");
      if (firstTokenMs === null && e.t !== "raw") {
        firstTokenMs = Date.now() - startedAtMs;
      }
      foldTranscriptEvent(totals, e);
      if (e.t === "tool" && stuckDetector.record(e.name, e.input)) trip("stuck");
    }
  });

  let promptError = "";
  try {
    await Promise.race([
      withStreamLiveness(noteActivity, () => session.prompt(opts.prompt)).catch((err) => {
        promptError = String(err instanceof Error ? err.message : err);
      }),
      watchdog,
    ]);
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(stallTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    try {
      await session.dispose();
    } catch {
      // Best-effort — the run is over regardless.
    }
    await closeTranscript();
  }

  // The watchdogs whose verdict overrides whatever the stream reported. A
  // timeout or external abort has no message of its own.
  const TRIP_ERRORS: Partial<Record<TripCause, string>> = {
    stalled: `harness emitted no output for ${Math.round(stallTimeoutMs / 1000)}s — stream hung (network drop or machine sleep?)`,
    stuck: "harness repeated the same tool call 4 times in a row — likely stuck",
    oversized: `assistant reply exceeded ${MAX_REPLY_CHARS / (1024 * 1024)} MiB in a single turn — likely a corrupted stream (duplicated deltas or leaked tool-call markup)`,
  };
  const tripError = tripped === null ? undefined : TRIP_ERRORS[tripped];
  if (tripError) {
    totals.error = tripError;
  } else if (!totals.error && promptError) {
    totals.error = promptError;
  }

  // An external abort is the caller's decision, not a failure of the run.
  const failed = Boolean(totals.error) || (tripped !== null && tripped !== "aborted");
  return result(failed ? 1 : 0);
}
