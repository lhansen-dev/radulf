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
  // The invariant: no role ever holds both bash and web_search.
  it.each([
    ["loop", false],
    ["evaluator", false],
    // No role and not readOnly defaults to the loop set.
    [undefined, false],
  ] as const)("gives %s bash but never web_search", (role, readOnly) => {
    const tools = toolsForRole(role, readOnly);
    expect(tools).toContain("bash");
    expect(tools).not.toContain("web_search");
  });

  it("gives the planner and readOnly sessions web_search but never bash", () => {
    const planner = toolsForRole("planner", false);
    expect(planner).toContain("web_search");
    expect(planner).not.toContain("bash");
    // write/edit are bound, L2-guarded to the plan dir.
    expect(planner).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "write", "edit"]));

    // readOnly = chat / improvement proposer: browse tools only.
    const ro = toolsForRole(undefined, true);
    expect(ro).toContain("web_search");
    for (const tool of ["bash", "write", "edit"]) expect(ro).not.toContain(tool);
  });
});

describe("pathRootsForRole — L2 roots (spec 14 Phase 3)", () => {
  it("lets the planner write only .ralph, and the loop/evaluator the whole worktree", () => {
    const wt = "/tmp/wt";
    expect(pathRootsForRole("planner", wt)).toEqual({ readRoots: [wt], writeRoots: [path.join(wt, ".ralph")] });
    expect(pathRootsForRole("loop", wt)).toEqual({ readRoots: [wt], writeRoots: [wt] });
    expect(pathRootsForRole("evaluator", wt)).toEqual({ readRoots: [wt], writeRoots: [wt] });
  });
});

describe("shouldSandboxBash — L1 routing (spec 14 Phase 6)", () => {
  const config = {} as const; // any defined value stands in for a resolved srtConfig

  it.each([
    ["loop", config, true],
    ["evaluator", config, true],
    // The planner holds no bash tool at all.
    ["planner", config, false],
    // A non-pipeline session (chat, improvement proposer).
    [undefined, config, false],
    // sandboxEnabled off: no srtConfig resolved.
    ["loop", undefined, false],
    ["evaluator", undefined, false],
  ] as const)("routes role %s with config %j → %s", (role, cfg, expected) => {
    expect(shouldSandboxBash(role, cfg)).toBe(expected);
  });
});

describe("omlxProviderConfig", () => {
  it("builds the omlx provider with baseUrl, anthropic-messages api, and the model, falling back on the api key", () => {
    const config = omlxProviderConfig("some-model", testSettings({ omlxBaseUrl: "http://localhost:8000", omlxApiKey: "" }));

    expect(config.baseUrl).toBe("http://localhost:8000");
    expect(config.api).toBe("anthropic-messages");
    expect(config.apiKey).toBe("omlx");
    expect(config.models[0].id).toBe("some-model");
    expect(config.models[0].name).toBe("some-model");
    expect(omlxProviderConfig("m", testSettings({ omlxApiKey: "secret" })).apiKey).toBe("secret");
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

  it("keeps thinking blocks (even redacted, textless ones) but drops empty text and empty thinking", () => {
    const evt = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "" },
          { type: "thinking", thinking: "" },
          { type: "thinking", thinking: "", thinkingSignature: "enc", redacted: true },
        ],
        usage: { input: 10, output: 2 },
        stopReason: "stop",
      },
    };
    expect(norm(evt)).toEqual([
      { t: "reasoning", content: "hmm" },
      { t: "reasoning", content: "", redacted: true },
      { t: "usage", inputTokens: 10, outputTokens: 2 },
    ]);
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
