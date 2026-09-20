// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useNow } from "./useNow";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useNow", () => {
  it("advances while active and freezes once active turns false", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const { result, rerender } = renderHook(({ active }) => useNow(active, 1000), {
      initialProps: { active: true },
    });
    const initial = result.current;
    expect(initial).toBe(Date.parse("2025-01-01T00:00:00Z"));

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current - initial).toBe(3000);

    rerender({ active: false });
    const frozen = result.current;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(frozen);
  });

  it("never advances when inactive from the start", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNow(false, 1000));
    const initial = result.current;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(initial);
  });
});
