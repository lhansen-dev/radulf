import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createTranscriptTotals,
  foldTranscriptEvent,
  MAX_REPLY_CHARS,
  runHarness,
  type HarnessSession,
} from "./index";
import type { TranscriptEvent } from "./types";
import { SETTING_DEFAULTS, type Settings } from "../settings";

describe("foldTranscriptEvent", () => {
  function fold(events: TranscriptEvent[]) {
    const totals = createTranscriptTotals();
    for (const e of events) foldTranscriptEvent(totals, e);
    return totals;
  }

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

  it("keeps unavailable fields null instead of coercing to zero", () => {
    const totals = fold([{ t: "usage", inputTokens: 100, outputTokens: 10 }]);
    expect(totals.cachedInputTokens).toBeNull();
    expect(totals.cacheWriteTokens).toBeNull();
    expect(totals.reasoningTokens).toBeNull();
    expect(totals.costUsd).toBeNull();
    expect(totals.toolDurationMs).toBeNull();
  });

  it("distinguishes an explicit zero from an unreported field", () => {
    const totals = fold([
      { t: "usage", inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    ]);
    expect(totals.cachedInputTokens).toBe(0);
  });

  it("has no model turns before any usage event arrives", () => {
    const totals = fold([{ t: "text", role: "assistant", content: "hi" }]);
    expect(totals.modelTurns).toBeNull();
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
  const scratch = "/tmp/ralph-stall-test";

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

  function textEvt(content: string): AgentSessionEvent {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: content }],
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

  function toolEvt(name: string, args: unknown): AgentSessionEvent {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name, arguments: args }],
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

  /** A fake session whose prompt runs `script` until it finishes or abort()
   * fires. abort() aborts the script's abort-aware waits, so prompt settles. */
  function fakeSession(
    script: (ctx: {
      emit: (e: AgentSessionEvent) => void;
      signal: AbortSignal;
    }) => Promise<void>,
  ): () => Promise<HarnessSession> {
    return async () => {
      let listener: ((e: AgentSessionEvent) => void) | undefined;
      const ac = new AbortController();
      return {
        subscribe(l) {
          listener = l;
          return () => {
            listener = undefined;
          };
        },
        prompt() {
          return script({ emit: (e) => listener?.(e), signal: ac.signal });
        },
        async abort() {
          ac.abort();
        },
        dispose() {},
      };
    };
  }

  it("kills an invocation that goes silent and reports it as stalled", async () => {
    fs.mkdirSync(scratch, { recursive: true });
    const result = await runHarness({
      provider: "openrouter",
      prompt: "",
      model: "m",
      reasoningLevel: "medium",
      cwd: scratch,
      transcriptPath: path.join(scratch, "stalled.jsonl"),
      timeoutMs: 60_000,
      stallTimeoutMs: 400,
      createSession: fakeSession(async ({ emit, signal }) => {
        emit(textEvt("started"));
        await sleep(30_000, signal); // silent → the 400ms watchdog trips
      }),
    });

    expect(result.stalled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.error).toContain("no output");
  }, 15_000);

  it("does not stall while events keep flowing", async () => {
    fs.mkdirSync(scratch, { recursive: true });
    const result = await runHarness({
      provider: "openrouter",
      prompt: "",
      model: "m",
      reasoningLevel: "medium",
      cwd: scratch,
      transcriptPath: path.join(scratch, "flowing.jsonl"),
      timeoutMs: 60_000,
      stallTimeoutMs: 700,
      // Five events 300ms apart — each resets the 700ms watchdog.
      createSession: fakeSession(async ({ emit, signal }) => {
        for (let i = 1; i <= 5; i++) {
          emit(textEvt(`tick ${i}`));
          await sleep(300, signal);
        }
      }),
    });

    expect(result.stalled).toBe(false);
    expect(result.code).toBe(0);
    expect(result.error).toBe("");
    expect(result.lastText).toBe("tick 5");
  }, 15_000);

  it("defaults the watchdog from stallTimeoutSeconds when the caller omits it", async () => {
    fs.mkdirSync(scratch, { recursive: true });
    const result = await runHarness({
      provider: "openrouter",
      prompt: "",
      model: "m",
      reasoningLevel: "medium",
      cwd: scratch,
      transcriptPath: path.join(scratch, "default-stall.jsonl"),
      timeoutMs: 60_000,
      // No stallTimeoutMs: this is what every real call site does, and it is
      // the setting — floored at 30s — that has to arm the watchdog.
      settings: { ...SETTING_DEFAULTS, stallTimeoutSeconds: 30 } as Settings,
      createSession: fakeSession(async ({ emit, signal }) => {
        emit(textEvt("started"));
        await sleep(60_000, signal);
      }),
    });

    expect(result.stalled).toBe(true);
    expect(result.error).toContain("no output for 30s");
  }, 45_000);

  it("leaves stalled false on the plain timeout path", async () => {
    fs.mkdirSync(scratch, { recursive: true });
    const result = await runHarness({
      provider: "openrouter",
      prompt: "",
      model: "m",
      reasoningLevel: "medium",
      cwd: scratch,
      transcriptPath: path.join(scratch, "timeout.jsonl"),
      timeoutMs: 500,
      stallTimeoutMs: 0, // watchdog off — this asserts the hard-timeout path alone
      createSession: fakeSession(async ({ emit, signal }) => {
        emit(textEvt("started"));
        await sleep(30_000, signal);
      }),
    });

    expect(result.timedOut).toBe(true);
    expect(result.stalled).toBe(false);
  }, 15_000);

  it("aborts an iteration that repeats the same tool call over and over", async () => {
    fs.mkdirSync(scratch, { recursive: true });
    const result = await runHarness({
      provider: "openrouter",
      prompt: "",
      model: "m",
      reasoningLevel: "medium",
      cwd: scratch,
      transcriptPath: path.join(scratch, "stuck.jsonl"),
      timeoutMs: 60_000,
      stallTimeoutMs: 0,
      createSession: fakeSession(async ({ emit, signal }) => {
        for (let i = 0; i < 10 && !signal.aborted; i++) {
          emit(toolEvt("bash", { cmd: "ls" }));
          await sleep(10, signal);
        }
      }),
    });

    expect(result.stuck).toBe(true);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain("repeated the same tool call");
  }, 15_000);

  it("does not trip stuck when tool calls vary", async () => {
    fs.mkdirSync(scratch, { recursive: true });
    const result = await runHarness({
      provider: "openrouter",
      prompt: "",
      model: "m",
      reasoningLevel: "medium",
      cwd: scratch,
      transcriptPath: path.join(scratch, "not-stuck.jsonl"),
      timeoutMs: 60_000,
      stallTimeoutMs: 0,
      createSession: fakeSession(async ({ emit, signal }) => {
        for (let i = 0; i < 6; i++) {
          emit(toolEvt("bash", { cmd: `step-${i}` }));
          await sleep(10, signal);
        }
      }),
    });

    expect(result.stuck).toBe(false);
    expect(result.code).toBe(0);
  }, 15_000);

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

  it("aborts an invocation whose single reply streams past MAX_REPLY_CHARS", async () => {
    fs.mkdirSync(scratch, { recursive: true });
    let deltasSent = 0;
    const result = await runHarness({
      provider: "openrouter",
      prompt: "",
      model: "m",
      reasoningLevel: "medium",
      cwd: scratch,
      transcriptPath: path.join(scratch, "oversized.jsonl"),
      timeoutMs: 60_000,
      stallTimeoutMs: 0,
      createSession: fakeSession(async ({ emit, signal }) => {
        emit(messageStartEvt);
        const chunk = "x".repeat(100_000);
        for (let i = 0; i < 50 && !signal.aborted; i++) {
          emit(textDeltaEvt(chunk));
          deltasSent += 1;
          await sleep(1, signal);
        }
      }),
    });

    expect(result.code).not.toBe(0);
    expect(result.error).toContain("assistant reply exceeded 1 MiB");
    // Tripped on the delta that crossed the limit, not after the stream ended.
    expect(deltasSent).toBe(Math.floor(MAX_REPLY_CHARS / 100_000) + 1);
  }, 15_000);

  it("counts reply size per message, not across the whole invocation", async () => {
    fs.mkdirSync(scratch, { recursive: true });
    const result = await runHarness({
      provider: "openrouter",
      prompt: "",
      model: "m",
      reasoningLevel: "medium",
      cwd: scratch,
      transcriptPath: path.join(scratch, "many-replies.jsonl"),
      timeoutMs: 60_000,
      stallTimeoutMs: 0,
      createSession: fakeSession(async ({ emit }) => {
        // Three replies of ~0.6 MiB each: 1.8 MiB in total, none over the cap.
        for (let reply = 0; reply < 3; reply++) {
          emit(messageStartEvt);
          for (let i = 0; i < 6; i++) emit(textDeltaEvt("x".repeat(100_000)));
          emit(textEvt(`reply ${reply}`));
        }
      }),
    });

    expect(result.code).toBe(0);
    expect(result.error).toBe("");
  }, 15_000);

  it("surfaces a session-construction failure as an error result", async () => {
    fs.mkdirSync(scratch, { recursive: true });
    const result = await runHarness({
      provider: "openrouter",
      prompt: "",
      model: "",
      reasoningLevel: "medium",
      cwd: scratch,
      transcriptPath: path.join(scratch, "ctor-fail.jsonl"),
      timeoutMs: 500,
      createSession: async () => {
        throw new Error("no model selected for the OpenRouter provider");
      },
    });

    expect(result.code).toBe(1);
    expect(result.error).toContain("no model selected");
  });
});
