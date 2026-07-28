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
 * Result of one runner invocation — spec 11 Phase 0 telemetry.
 *
 * Token fields sum per-model-turn usage events; a field is null when the
 * harness never reported it (unavailable stays unavailable — never coerced
 * to zero).
 */
export type RunnerResult = {
  code: number | null;
  timedOut: boolean;
  /** True when the invocation was killed by the stall watchdog: the harness
   * emitted nothing for `stallTimeoutMs` (hung provider stream, dropped
   * network, machine sleep). */
  stalled: boolean;
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
  /** Wall-clock ms from session start to the first normalized (non-raw) event. */
  firstTokenMs: number | null;
  harness: HarnessId;
  harnessVersion: string | null;
};

/**
 * Streaming accumulator for normalized transcript events — the single place
 * that turns per-turn usage/tool events into invocation totals, exported so
 * unit tests can drive it with pinned fixtures.
 */
export type TranscriptTotals = {
  lastText: string;
  error: string;
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  modelTurns: number | null;
  toolCalls: number;
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

export function foldTranscriptEvent(totals: TranscriptTotals, event: TranscriptEvent): void {
  if (event.t === "text") {
    totals.lastText = event.content;
  } else if (event.t === "tool") {
    totals.toolCalls += 1;
    if (event.durationMs !== undefined) {
      totals.toolDurationMs = (totals.toolDurationMs ?? 0) + event.durationMs;
    }
  } else if (event.t === "usage") {
    // Every usage event is one model turn (pi emits one assistant message_end
    // per turn) — counting them can never double-count.
    totals.modelTurns = (totals.modelTurns ?? 0) + 1;
    totals.promptTokens += event.inputTokens;
    totals.completionTokens += event.outputTokens;
    if (event.cachedInputTokens !== undefined) {
      totals.cachedInputTokens = (totals.cachedInputTokens ?? 0) + event.cachedInputTokens;
    }
    if (event.cacheWriteTokens !== undefined) {
      totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + event.cacheWriteTokens;
    }
    if (event.reasoningTokens !== undefined) {
      totals.reasoningTokens = (totals.reasoningTokens ?? 0) + event.reasoningTokens;
    }
    if (event.costUsd !== undefined) {
      totals.costUsd = (totals.costUsd ?? 0) + event.costUsd;
    }
  } else if (event.t === "result") {
    if (event.exit === "failed") {
      totals.error = event.detail ?? "unknown error";
    }
    if (event.numTurns !== undefined) {
      totals.modelTurns = event.numTurns;
    }
  }
}

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
  let timedOut = false;
  let stalled = false;
  const startedAtMs = Date.now();
  const version = harnessPackageVersion();

  fs.mkdirSync(path.dirname(opts.transcriptPath), { recursive: true });
  const out = fs.createWriteStream(opts.transcriptPath, { flags: "a" });

  const result = (code: number | null): RunnerResult => ({
    code,
    timedOut,
    stalled,
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
    out.end();
    totals.error = String(err instanceof Error ? err.message : err);
    return result(1);
  }

  // Watchdog race: any of the three triggers aborts the session and unblocks.
  let releaseWatchdog: () => void = () => {};
  const watchdog = new Promise<void>((res) => {
    releaseWatchdog = res;
  });
  const trip = (mark: () => void) => {
    mark();
    void session.abort().catch(() => {});
    releaseWatchdog();
  };

  const hardTimer = setTimeout(() => trip(() => (timedOut = true)), opts.timeoutMs);

  // Stall watchdog: any streamed event resets it — including the
  // `message_update` deltas piNormalize drops, so a model that is merely slow
  // (a long high-effort thinking block) keeps the timer alive. Only a stream
  // that hangs without erroring (network drop, machine sleep) trips it.
  // Defaulted from settings here rather than at the call sites so every model
  // call is covered; the floor keeps a mistyped setting from killing runs.
  const stallTimeoutMs =
    opts.stallTimeoutMs === undefined
      ? Math.max(30_000, s().stallTimeoutSeconds * 1000)
      : opts.stallTimeoutMs;
  let stallTimer: NodeJS.Timeout | undefined;
  const resetStallTimer = () => {
    if (stallTimeoutMs <= 0) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => trip(() => (stalled = true)), stallTimeoutMs);
  };
  resetStallTimer();

  const onAbort = () => trip(() => {});
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const unsubscribe = session.subscribe((evt) => {
    resetStallTimer();
    for (const e of piNormalize(evt)) {
      out.write(JSON.stringify(e) + "\n");
      if (firstTokenMs === null && e.t !== "raw") {
        firstTokenMs = Date.now() - startedAtMs;
      }
      foldTranscriptEvent(totals, e);
    }
  });

  let promptError = "";
  try {
    await Promise.race([
      session.prompt(opts.prompt).catch((err) => {
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
    out.end();
  }

  if (stalled) {
    totals.error = `harness emitted no output for ${Math.round(stallTimeoutMs / 1000)}s — stream hung (network drop or machine sleep?)`;
  } else if (!totals.error && promptError) {
    totals.error = promptError;
  }

  const failed = Boolean(totals.error) || timedOut || stalled;
  return result(failed ? 1 : 0);
}
