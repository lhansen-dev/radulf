// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useCardDetail } from "./useCardDetail";

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

function jsonResponse(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
  );
}

let cardStatus = "looping";
const fetchMock = vi.fn((url: string) => {
  if (url === "/api/cards/c1") {
    return jsonResponse({ card: { id: "c1", status: cardStatus }, repo: null, plans: [], runs: [], events: [] });
  }
  return Promise.reject(new Error(`unexpected fetch: ${url}`));
});
const detailFetches = () => fetchMock.mock.calls.filter(([url]) => url === "/api/cards/c1").length;

beforeEach(() => {
  cardStatus = "looping";
  fetchMock.mockClear();
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
});

describe("useCardDetail stream reconnect", () => {
  it("refetches the card after the event stream reconnects, but not on the first open", async () => {
    const { result } = renderHook(() => useCardDetail("c1"));
    await waitFor(() => expect(result.current.detail?.card.status).toBe("looping"));
    const es = MockEventSource.instances[0];
    act(() => es.onopen?.());
    expect(detailFetches()).toBe(1);

    act(() => es.onerror?.(new Event("error")));
    cardStatus = "review";
    act(() => es.onopen?.());

    await waitFor(() => expect(result.current.detail?.card.status).toBe("review"));
    expect(detailFetches()).toBe(2);
  });
});
