// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { api, useEventStream } from "./api";

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  readyState = 0;
  static instances: MockEventSource[] = [];
  constructor() {
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
});

describe("useEventStream", () => {
  it("shares one EventSource across subscribers and closes it after the last unmounts", () => {
    const first = vi.fn();
    const firstConnection = vi.fn();
    const second = vi.fn();
    const secondConnection = vi.fn();
    const a = renderHook(() => useEventStream(first, firstConnection));
    const b = renderHook(() => useEventStream(second, secondConnection));
    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0];

    act(() => es.onopen?.());
    expect(firstConnection).toHaveBeenCalledWith(true);
    expect(secondConnection).toHaveBeenCalledWith(true);

    const event = { type: "card.moved", cardId: "c1" };
    act(() => es.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));
    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);

    a.unmount();
    expect(es.closed).toBe(false);
    b.unmount();
    expect(es.closed).toBe(true);
  });

  it("tells a late subscriber the connection state its own stream would have reported", () => {
    renderHook(() => useEventStream(() => {}, () => {}));
    const es = MockEventSource.instances[0];
    act(() => es.onerror?.(new Event("error")));

    const late = vi.fn();
    renderHook(() => useEventStream(() => {}, late));
    expect(MockEventSource.instances).toHaveLength(1);
    expect(late).toHaveBeenCalledWith(false);
  });

  it("reopens a stream the browser closed for good, such as after a proxy's 502", () => {
    vi.useFakeTimers();
    try {
      const connection = vi.fn();
      renderHook(() => useEventStream(() => {}, connection));
      const first = MockEventSource.instances[0];
      first.readyState = 2; // CLOSED: an HTTP error, which EventSource never retries
      act(() => first.onerror?.(new Event("error")));
      expect(connection).toHaveBeenLastCalledWith(false);

      act(() => vi.advanceTimersByTime(3_000));
      expect(MockEventSource.instances).toHaveLength(2);
      act(() => MockEventSource.instances[1].onopen?.());
      expect(connection).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still delivers a frame to the other subscribers when one callback throws", () => {
    renderHook(() => useEventStream(() => { throw new Error("boom"); }));
    const second = vi.fn();
    renderHook(() => useEventStream(second));
    const es = MockEventSource.instances[0];
    const event = { type: "card.moved", cardId: "c1" };
    act(() => es.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));
    expect(second).toHaveBeenCalledWith(event);
  });
});

describe("api", () => {
  it("sends the browser to /login once its session is gone, and still throws", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, origin: "http://localhost:3000" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })));
    try {
      await expect(api("/api/cards")).rejects.toThrow("Unauthorized");
      expect(String(assign.mock.calls[0][0])).toBe("http://localhost:3000/login");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
