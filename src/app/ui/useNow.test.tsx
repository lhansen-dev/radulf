// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useNow } from "./useNow";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useNow", () => {
  it("returns a number that increases while active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const { result } = renderHook(() => useNow(true, 1000));
    const initial = result.current;
    expect(initial).toBe(new Date("2025-01-01T00:00:00Z").getTime());

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    const after = result.current;
    expect(after - initial).toBe(3000);
  });

  it("stays constant when active is false", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const { result } = renderHook(() => useNow(false, 1000));
    const initial = result.current;

    vi.advanceTimersByTime(5000);
    const after = result.current;
    expect(after).toBe(initial);
  });

  it("stops advancing after active toggles to false", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const { result, rerender } = renderHook(
      ({ active }) => useNow(active, 1000),
      { initialProps: { active: true } },
    );
    const initial = result.current;

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const afterTick = result.current;
    expect(afterTick - initial).toBe(2000);

    // Toggle active to false
    rerender({ active: false });
    const afterDeactivate = result.current;

    // Advance more time — value should not change
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    const afterLongWait = result.current;
    expect(afterLongWait).toBe(afterDeactivate);
  });
});