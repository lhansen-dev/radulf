import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createTranscriptTotals,
  foldTranscriptEvent,
  MAX_REPLY_CHARS,
  runHarness,
} from "./index";
import type { TranscriptEvent } from "./types";
import { testSettings } from "@/testUtils/testSettings";

describe("foldTranscriptEvent", () => {
  function fold(events: TranscriptEvent[]) {
    const totals = createTranscriptTotals();
    for (const e of events) foldTranscriptEvent(totals, e);
    return totals;
  }

  it("clears a request error that pi's auto-retry then recovered from", () => {
    expect(
      fold([
        { t: "result", exit: "failed", detail: "Connection error." },
        { t: "result", exit: "completed" },
      ]).error,
    ).toBe("");
    expect(
      fold([
        { t: "result", exit: "failed", detail: "Connection error." },
        { t: "result", exit: "failed", detail: "429 rate limited" },
      ]).error,
    ).toBe("429 rate limited");
  });

  it("sums per-turn usage events and counts them as model turns", () => {
    const totals = fold([
      {
        t: "usage",
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 1000,
        cacheWriteTokens: 50,
        reasoningTokens: 5,
        costUsd: 0.01,
      },
      {
        t: "usage",
        inputTokens: 200,
        outputTokens: 20,
        cachedInputTokens: 2000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.02,
      },
    ]);
    expect(totals.promptTokens).toBe(300);
    expect(totals.completionTokens).toBe(30);
    expect(totals.cachedInputTokens).toBe(3000);
    expect(totals.cacheWriteTokens).toBe(50);
    expect(totals.reasoningTokens).toBe(5);
    expect(totals.costUsd).toBeCloseTo(0.03);
    expect(totals.modelTurns).toBe(2);
  });

  it("keeps unreported fields null, distinct from an explicit zero", () => {
    expect(fold([{ t: "text", role: "assistant", content: "hi" }]).modelTurns).toBeNull();
    const totals = fold([
      { t: "usage", inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    ]);
    expect(totals.cachedInputTokens).toBe(0);
    expect(totals.cacheWriteTokens).toBeNull();
    expect(totals.reasoningTokens).toBeNull();
    expect(totals.costUsd).toBeNull();
    expect(totals.toolDurationMs).toBeNull();
  });

  it("prefers a harness-reported turn count over the usage-event count", () => {
    // Cumulative-only adapters (claude-code) emit one usage event but a real
    // num_turns on the result event.
    const totals = fold([
      { t: "usage", inputTokens: 18, outputTokens: 319 },
      { t: "result", exit: "completed", numTurns: 7 },
    ]);
    expect(totals.modelTurns).toBe(7);
  });

  it("counts tool calls and sums only reported durations", () => {
    const totals = fold([
      { t: "tool", name: "read", input: {}, durationMs: 5 },
      { t: "tool", name: "bash", input: {} },
      { t: "tool", name: "edit", input: {}, durationMs: 10 },
    ]);
    expect(totals.toolCalls).toBe(3);
    expect(totals.toolDurationMs).toBe(15);
  });

  it("records failure detail from the result event and last assistant text", () => {
    const totals = fold([
      { t: "text", role: "assistant", content: "first" },
      { t: "text", role: "assistant", content: "second" },
      { t: "result", exit: "failed", detail: "boom" },
    ]);
    expect(totals.lastText).toBe("second");
    expect(totals.error).toBe("boom");
  });
});

describe("runHarness watchdogs", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-stall-test-"));

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }

  function messageEndEvt(content: unknown[]): AgentSessionEvent {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        content,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    } as unknown as AgentSessionEvent;
  }
  const textEvt = (text: string) => messageEndEvt([{ type: "text", text }]);
  const toolEvt = (name: string, args: unknown) =>
    messageEndEvt([{ type: "toolCall", name, arguments: args }]);

  /** One streamed text delta inside an assistant message. */
  function textDeltaEvt(delta: string): AgentSessionEvent {
    return {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    } as unknown as AgentSessionEvent;
  }

  const messageStartEvt = {
    type: "message_start",
    message: { role: "assistant", content: [] },
  } as unknown as AgentSessionEvent;

  /** Mirrors pi ending an in-flight turn on abort: message_end with
   * stopReason "aborted" rather than the prompt promise rejecting. */
  function abortedEvt(): AgentSessionEvent {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "aborted",
        timestamp: Date.now(),
      },
    } as unknown as AgentSessionEvent;
  }

  /** Mirrors pi ending a turn on a genuine (non-abort) failure. */
  function failedEvt(errorMessage: string): AgentSessionEvent {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage,
        timestamp: Date.now(),
      },
    } as unknown as AgentSessionEvent;
  }

  type Script = (ctx: {
    emit: (e: AgentSessionEvent) => void;
    signal: AbortSignal;
  }) => Promise<void>;

  /** Run the harness against a fake session whose prompt runs `script` until it
   * finishes or abort() fires. abort() aborts the script's abort-aware waits,
   * so prompt settles. */
  function run(script: Script, opts: Partial<Parameters<typeof runHarness>[0]> = {}) {
    fs.mkdirSync(scratch, { recursive: true });
    return runHarness({
      provider: "openrouter",
      prompt: "",
      model: "m",
      reasoningLevel: "medium",
      cwd: scratch,
      transcriptPath: path.join(scratch, "run.jsonl"),
      timeoutMs: 60_000,
      stallTimeoutMs: 0,
      createSession: async () => {
        let listener: ((e: AgentSessionEvent) => void) | undefined;
        const ac = new AbortController();
        return {
          subscribe(l) {
            listener = l;
            return () => {
              listener = undefined;
            };
          },
          prompt: () => script({ emit: (e) => listener?.(e), signal: ac.signal }),
          async abort() {
            ac.abort();
          },
          dispose() {},
        };
      },
      ...opts,
    });
  }

  /** Like `run`, on fake timers advanced by `ms` so time-based watchdogs trip
   * without the test waiting on a real clock. Date is faked too: the stall
   * watchdog compares Date.now() against its last-activity timestamp. */
  async function runFor(ms: number, script: Script, opts: Parameters<typeof run>[1] = {}) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pending = run(script, opts);
    await vi.advanceTimersByTimeAsync(ms);
    return pending;
  }

  const silentAfterStart: Script = async ({ emit, signal }) => {
    emit(textEvt("started"));
    await sleep(600_000, signal);
  };

  it("kills an invocation that goes silent and reports it as stalled", async () => {
    const result = await runFor(400, silentAfterStart, { stallTimeoutMs: 400 });

    expect(result.stalled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.error).toContain("no output");
  });

  it("does not stall while events keep flowing", async () => {
    // Five events 300ms apart — each resets the 700ms watchdog.
    const result = await runFor(
      1_500,
      async ({ emit, signal }) => {
        for (let i = 1; i <= 5; i++) {
          emit(textEvt(`tick ${i}`));
          await sleep(300, signal);
        }
      },
      { stallTimeoutMs: 700 },
    );

    expect(result.stalled).toBe(false);
    expect(result.code).toBe(0);
    expect(result.error).toBe("");
    expect(result.lastText).toBe("tick 5");
  });

  it("defaults the watchdog from stallTimeoutSeconds, floored at 30s", async () => {
    // No stallTimeoutMs: this is what every real call site does, and it is the
    // setting — floored at 30s — that has to arm the watchdog.
    const result = await runFor(30_000, silentAfterStart, {
      stallTimeoutMs: undefined,
      settings: testSettings({ stallTimeoutSeconds: 1 }),
    });

    expect(result.stalled).toBe(true);
    expect(result.error).toContain("no output for 30s");
  });

  it("leaves stalled false on the plain timeout path", async () => {
    const result = await runFor(500, silentAfterStart, { timeoutMs: 500 });

    expect(result.timedOut).toBe(true);
    expect(result.stalled).toBe(false);
  });

  it("aborts on a repeated tool call but not on varied ones", async () => {
    const stuck = await run(async ({ emit, signal }) => {
      for (let i = 0; i < 10 && !signal.aborted; i++) {
        emit(toolEvt("bash", { cmd: "ls" }));
        await sleep(10, signal);
      }
    });
    expect(stuck.stuck).toBe(true);
    expect(stuck.code).not.toBe(0);
    expect(stuck.error).toContain("repeated the same tool call");

    const varied = await run(async ({ emit }) => {
      for (let i = 0; i < 6; i++) emit(toolEvt("bash", { cmd: `step-${i}` }));
    });
    expect(varied.stuck).toBe(false);
    expect(varied.code).toBe(0);
  });

  it("aborts an invocation whose single reply streams past MAX_REPLY_CHARS", async () => {
    let deltasSent = 0;
    const result = await run(async ({ emit, signal }) => {
      emit(messageStartEvt);
      const chunk = "x".repeat(100_000);
      for (let i = 0; i < 50 && !signal.aborted; i++) {
        emit(textDeltaEvt(chunk));
        deltasSent += 1;
        await sleep(1, signal);
      }
    });

    expect(result.code).not.toBe(0);
    expect(result.error).toContain("assistant reply exceeded 1 MiB");
    // Tripped on the delta that crossed the limit, not after the stream ended.
    expect(deltasSent).toBe(Math.floor(MAX_REPLY_CHARS / 100_000) + 1);
  });

  it("counts reply size per message, not across the whole invocation", async () => {
    const result = await run(async ({ emit }) => {
      // Three replies of ~0.6 MiB each: 1.8 MiB in total, none over the cap.
      for (let reply = 0; reply < 3; reply++) {
        emit(messageStartEvt);
        for (let i = 0; i < 6; i++) emit(textDeltaEvt("x".repeat(100_000)));
        emit(textEvt(`reply ${reply}`));
      }
    });

    expect(result.code).toBe(0);
    expect(result.error).toBe("");
  });

  it("does not report an external abort that lands mid-turn as a failure", async () => {
    // An abort mid-stream doesn't reject session.prompt() — pi ends the turn
    // with its own message_end{stopReason:"aborted"}, which is what trips the
    // bug this test guards: that stream message must not read back as
    // totals.error once the caller's own abort decision unwinds it.
    const ac = new AbortController();
    const result = await run(
      async ({ emit, signal }) => {
        emit(messageStartEvt);
        // The caller cancels while the turn is in flight.
        ac.abort();
        // trip("aborted") already called session.abort() synchronously above,
        // which aborts this fake session's internal signal — mirrors pi
        // unwinding the in-flight request before it emits the turn's result.
        await sleep(0, signal);
        emit(abortedEvt());
      },
      { signal: ac.signal },
    );

    expect(result.code).toBe(0);
    expect(result.error).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.stalled).toBe(false);
    expect(result.stuck).toBe(false);
  });

  it("keeps a genuine pre-abort failure even when the abort follows it", async () => {
    // If a real error already happened before the caller asked to cancel,
    // the abort that follows must not erase it.
    const ac = new AbortController();
    const result = await run(
      async ({ emit, signal }) => {
        emit(failedEvt("429 rate limited"));
        emit(messageStartEvt);
        ac.abort();
        await sleep(0, signal);
        emit(abortedEvt());
      },
      { signal: ac.signal },
    );

    expect(result.code).not.toBe(0);
    expect(result.error).toBe("429 rate limited");
  });

  it("surfaces a session-construction failure as an error result", async () => {
    const result = await run(async () => {}, {
      createSession: async () => {
        throw new Error("no model selected for the OpenRouter provider");
      },
    });

    expect(result.code).toBe(1);
    expect(result.error).toContain("no model selected");
  });
});
