// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useWorkData } from "./useWorkData";

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

let notificationsEnabled = false;

function mockFetchFor(url: string) {
  if (url === "/api/cards") return jsonResponse([]);
  if (url === "/api/repos") return jsonResponse([]);
  if (url === "/api/settings") {
    return jsonResponse({ autoMode: true, notificationsEnabled, soundEnabled: false });
  }
  if (url === "/api/health") return jsonResponse({});
  if (url === "/api/improvement-runs") return jsonResponse({ runs: [] });
  return Promise.reject(new Error(`unexpected fetch: ${url}`));
}

function emitImprovementCompleted(overrides: Partial<{
  featureBranch: string;
  tasksSucceeded: number;
  status: string;
}> = {}) {
  const es = MockEventSource.instances[0];
  act(() => {
    es.onmessage?.({
      data: JSON.stringify({
        type: "improvement.completed",
        cardId: null,
        payload: JSON.stringify({
          runId: "r1",
          featureBranch: "ralph/improve-1",
          tasksSucceeded: 3,
          status: "completed",
          reason: "deadline",
          ...overrides,
        }),
      }),
    } as MessageEvent);
  });
}

beforeEach(() => {
  cleanup();
  notificationsEnabled = false;
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  globalThis.fetch = vi.fn(mockFetchFor) as unknown as typeof fetch;
  // jsdom has no Notification global by default.
  delete (globalThis as { Notification?: unknown }).Notification;
});

afterEach(() => {
  cleanup();
});

describe("useWorkData improvement-run completion alert", () => {
  it("surfaces an in-app alert when browser notifications are unavailable", async () => {
    const { result } = renderHook(() => useWorkData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    emitImprovementCompleted();

    await waitFor(() =>
      expect(result.current.improvementAlert).toEqual({
        featureBranch: "ralph/improve-1",
        tasksSucceeded: 3,
        status: "completed",
      })
    );
  });

  it("dismisses the in-app alert", async () => {
    const { result } = renderHook(() => useWorkData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    emitImprovementCompleted();
    await waitFor(() => expect(result.current.improvementAlert).not.toBeNull());

    act(() => result.current.dismissImprovementAlert());
    expect(result.current.improvementAlert).toBeNull();
  });

  it("fires a browser notification instead of the in-app alert when enabled", async () => {
    notificationsEnabled = true;
    const NotificationSpy = vi.fn();
    (globalThis as unknown as { Notification: typeof Notification }).Notification = Object.assign(
      NotificationSpy,
      { permission: "granted" as NotificationPermission }
    ) as unknown as typeof Notification;

    const { result } = renderHook(() => useWorkData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    emitImprovementCompleted({ status: "failed", tasksSucceeded: 1 });

    await waitFor(() => expect(NotificationSpy).toHaveBeenCalledWith(
      "Improvement run failed",
      expect.objectContaining({ body: expect.stringContaining("ralph/improve-1") })
    ));
    expect(result.current.improvementAlert).toBeNull();
  });
});
