import { describe, it, expect } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { omlxProviderConfig, pathRootsForRole, piNormalize, shouldSandboxBash, toolsForRole } from "./pi";
import { SETTING_DEFAULTS, type Settings } from "../settings";

/** A minimal settings object for testing — never touches the db. */
function testSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...SETTING_DEFAULTS, ...overrides } as Settings;
}

/** piNormalize takes SDK event objects; cast arbitrary shapes for the tests. */
function norm(evt: unknown) {
  return piNormalize(evt as AgentSessionEvent);
}

describe("toolsForRole — role capability split (spec 14 Phase 2b)", () => {
  it("binds web_search to the planner ONLY, and never bash", () => {
    const planner = toolsForRole("planner", false);
    expect(planner).toContain("web_search");
    expect(planner).not.toContain("bash");
    // write/edit are bound (L2-guarded to the plan dir in Phase 3).
    expect(planner).toEqual(
      expect.arrayContaining(["read", "grep", "find", "ls", "write", "edit"]),
    );
  });

  it("gives the loop bash but never web_search", () => {
    const loop = toolsForRole("loop", false);
    expect(loop).toContain("bash");
    expect(loop).not.toContain("web_search");
  });

  it("gives the evaluator bash but never web_search", () => {
    const evaluator = toolsForRole("evaluator", false);
    expect(evaluator).toContain("bash");
    expect(evaluator).not.toContain("web_search");
  });

  it("never lets a bash-holding role also hold web_search (the invariant)", () => {
    for (const role of ["loop", "evaluator"] as const) {
      const tools = toolsForRole(role, false);
      const hasBash = tools.includes("bash");
      const hasWeb = tools.includes("web_search");
      expect(hasBash && hasWeb).toBe(false);
    }
  });

  it("readOnly (chat / improvement proposer) gets browse tools + web_search but no bash or write", () => {
    const ro = toolsForRole(undefined, true);
    expect(ro).toContain("web_search");
    expect(ro).not.toContain("bash");
    expect(ro).not.toContain("write");
    expect(ro).not.toContain("edit");
  });

  it("defaults to the loop set (bash, no web_search) with no role and not readOnly", () => {
    const dflt = toolsForRole(undefined, false);
    expect(dflt).toContain("bash");
    expect(dflt).not.toContain("web_search");
  });
});

describe("pathRootsForRole — L2 roots (spec 14 Phase 3)", () => {
  const wt = "/tmp/wt";

  it("gives the planner the whole checkout to read but only .ralph to write", () => {
    expect(pathRootsForRole("planner", wt)).toEqual({
      readRoots: [wt],
      writeRoots: [path.join(wt, ".ralph")],
    });
  });

  it("gives the loop the worktree for both read and write", () => {
    expect(pathRootsForRole("loop", wt)).toEqual({
      readRoots: [wt],
      writeRoots: [wt],
    });
  });

  it("gives the evaluator the worktree for both read and write", () => {
    expect(pathRootsForRole("evaluator", wt)).toEqual({
      readRoots: [wt],
      writeRoots: [wt],
    });
  });
});

describe("shouldSandboxBash — L1 routing (spec 14 Phase 6)", () => {
  const config = {} as const; // any defined value stands in for a resolved srtConfig

  it("sandboxes the loop and evaluator when srtConfig resolved", () => {
    expect(shouldSandboxBash("loop", config)).toBe(true);
    expect(shouldSandboxBash("evaluator", config)).toBe(true);
  });

  it("never sandboxes the planner — it holds no bash tool at all", () => {
    expect(shouldSandboxBash("planner", config)).toBe(false);
  });

  it("never sandboxes a non-pipeline session (no role — chat, improvement proposer)", () => {
    expect(shouldSandboxBash(undefined, config)).toBe(false);
  });

  it("does not sandbox a bash-holding role when srtConfig is absent (sandboxEnabled off)", () => {
    expect(shouldSandboxBash("loop", undefined)).toBe(false);
    expect(shouldSandboxBash("evaluator", undefined)).toBe(false);
  });
});

describe("omlxProviderConfig", () => {
  it("builds the omlx provider with baseUrl, anthropic-messages api, apiKey fallback, and the model", () => {
    const s = testSettings({ omlxBaseUrl: "http://localhost:8000", omlxApiKey: "" });
    const config = omlxProviderConfig("some-model", s);

    expect(config.baseUrl).toBe("http://localhost:8000");
    expect(config.api).toBe("anthropic-messages");
    expect(config.apiKey).toBe("omlx"); // fallback
    expect(config.models[0].id).toBe("some-model");
    expect(config.models[0].name).toBe("some-model");
  });

  it("uses the configured oMLX api key when present", () => {
    const s = testSettings({ omlxApiKey: "secret" });
    expect(omlxProviderConfig("m", s).apiKey).toBe("secret");
  });
});

describe("piNormalize", () => {
  it("drops streaming deltas and lifecycle framing", () => {
    for (const type of [
      "agent_start",
      "turn_start",
      "message_start",
      "message_update",
      "tool_execution_start",
      "tool_execution_update",
      "turn_end",
      "agent_end",
    ]) {
      expect(norm({ type })).toEqual([]);
    }
  });

  it("maps an assistant message_end to text, tool, and usage events", () => {
    // Shape per the SDK's emitted AssistantMessage (packages/ai types).
    const evt = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Editing the file now." },
          { type: "toolCall", id: "tc_1", name: "edit", arguments: { path: "x.ts" } },
        ],
        usage: {
          input: 1200,
          output: 80,
          cacheRead: 40000,
          cacheWrite: 0,
          totalTokens: 41280,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
        },
        stopReason: "toolUse",
        timestamp: 1752480000000,
      },
    };
    expect(norm(evt)).toEqual([
      { t: "text", role: "assistant", content: "Editing the file now." },
      { t: "tool", name: "edit", input: { path: "x.ts" } },
      {
        t: "usage",
        inputTokens: 1200,
        outputTokens: 80,
        cachedInputTokens: 40000,
        cacheWriteTokens: 0,
        costUsd: 0.01,
        timestampMs: 1752480000000,
      },
    ]);
  });

  it("skips empty text blocks but keeps thinking blocks", () => {
    const evt = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "" },
        ],
        usage: { input: 10, output: 2 },
        stopReason: "stop",
      },
    };
    expect(norm(evt)).toEqual([
      { t: "reasoning", content: "hmm" },
      { t: "usage", inputTokens: 10, outputTokens: 2 },
    ]);
  });

  it("keeps a redacted thinking block, which carries no text", () => {
    const evt = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "", thinkingSignature: "enc", redacted: true }],
        usage: { input: 10, output: 2 },
        stopReason: "stop",
      },
    };
    expect(norm(evt)).toEqual([
      { t: "reasoning", content: "", redacted: true },
      { t: "usage", inputTokens: 10, outputTokens: 2 },
    ]);
  });

  it("drops an empty, non-redacted thinking block", () => {
    const evt = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
        usage: { input: 10, output: 2 },
        stopReason: "stop",
      },
    };
    expect(norm(evt)).toEqual([{ t: "usage", inputTokens: 10, outputTokens: 2 }]);
  });

  it("maps message_end with stopReason error to result:failed", () => {
    const evt = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 5, output: 0 },
        stopReason: "error",
        errorMessage: "overloaded",
      },
    };
    expect(norm(evt)).toEqual([
      { t: "usage", inputTokens: 5, outputTokens: 0 },
      { t: "result", exit: "failed", detail: "overloaded" },
    ]);
  });

  it("keeps a non-assistant message_end as raw", () => {
    const evt = {
      type: "message_end",
      message: { role: "toolResult", toolCallId: "tc_1", content: [] },
    };
    expect(norm(evt)).toEqual([{ t: "raw", line: JSON.stringify(evt) }]);
  });

  it("maps a failed auto_retry_end to result:failed", () => {
    const evt = { type: "auto_retry_end", success: false, attempt: 3, finalError: "429 rate limited" };
    expect(norm(evt)).toEqual([{ t: "result", exit: "failed", detail: "429 rate limited" }]);
  });

  it("keeps a successful auto_retry_end as raw and marks the retry completed", () => {
    const evt = { type: "auto_retry_end", success: true, attempt: 1 };
    expect(norm(evt)).toEqual([
      { t: "raw", line: JSON.stringify(evt) },
      { t: "result", exit: "completed" },
    ]);
  });

  it("preserves tool_execution_end and unknown events as raw", () => {
    const end = {
      type: "tool_execution_end",
      toolCallId: "tc_1",
      toolName: "bash",
      result: "ok",
      isError: false,
    };
    expect(norm(end)).toEqual([{ t: "raw", line: JSON.stringify(end) }]);

    const unknown = { type: "queue_update", steering: [], followUp: [] };
    expect(norm(unknown)).toEqual([{ t: "raw", line: JSON.stringify(unknown) }]);
  });
});
