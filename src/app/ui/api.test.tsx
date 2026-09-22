// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEventStream } from "./api";

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
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
});
