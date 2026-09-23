// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { describeTranscriptLine, useRunActivity } from "./useRunActivity";

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  static instances: MockEventSource[] = [];
  constructor() {
    MockEventSource.instances.push(this);
  }
  close() {}
}

beforeEach(() => {
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const frame = (runId: string, lines: unknown[]) =>
  new MessageEvent("message", {
    data: JSON.stringify({ kind: "transcript", runId, iteration: 0, fromCursor: 0, cursor: 1, lines }),
  });

describe("describeTranscriptLine", () => {
  it.each([
    [{ t: "tool", name: "read", input: { path: "src/a.ts" } }, "read src/a.ts"],
    [{ t: "tool", name: "ls", input: {} }, "ls"],
    [{ t: "reasoning", content: "hmm" }, "Thinking"],
    [{ t: "text", content: "Here is" }, "Writing"],
    [{ t: "usage", inputTokens: 1 }, null],
    [{ t: "raw", event: {} }, null],
  ])("describes %j as %j", (line, expected) => {
    expect(describeTranscriptLine(line)).toBe(expected);
  });
});

describe("useRunActivity", () => {
  it("tracks pushes for its run only, and keeps the last label through pushes that describe nothing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result } = renderHook(() => useRunActivity("scoping:c1"));
    expect(result.current).toEqual({ lastAt: null, label: null });
    const es = MockEventSource.instances[0];

    act(() => es.onmessage?.(frame("other-run", [{ t: "tool", name: "bash", input: { command: "ls" } }])));
    expect(result.current.lastAt).toBeNull();

    act(() => es.onmessage?.(frame("scoping:c1", [{ t: "tool", name: "grep", input: { pattern: "login" } }, { t: "usage" }])));
    expect(result.current).toEqual({ lastAt: 1_000_000, label: "grep login" });

    vi.setSystemTime(1_005_000);
    act(() => es.onmessage?.(frame("scoping:c1", [{ t: "raw", event: {} }])));
    expect(result.current).toEqual({ lastAt: 1_005_000, label: "grep login" });
  });

  it("reads as idle again when pointed at a different run", () => {
    const { result, rerender } = renderHook(({ runId }: { runId: string | null }) => useRunActivity(runId), {
      initialProps: { runId: "a" as string | null },
    });
    const es = MockEventSource.instances[0];
    act(() => es.onmessage?.(frame("a", [{ t: "reasoning", content: "" }])));
    expect(result.current.label).toBe("Thinking");

    rerender({ runId: "b" });
    expect(result.current).toEqual({ lastAt: null, label: null });
  });
});
