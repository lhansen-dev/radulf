import { describe, it, expect } from "vitest";
import { formatDuration } from "./formatDuration";

const START = "2025-01-01T00:00:00Z";

describe("formatDuration", () => {
  it.each([
    ["2025-01-01T00:00:05Z", "5s"],
    ["2025-01-01T00:02:15Z", "2m 15s"],
  ])("formats a completed range ending %s as %s", (endedAt, expected) => {
    expect(formatDuration(START, endedAt)).toBe(expected);
  });

  it("counts live elapsed time from nowMs while running, or shows an em dash without it", () => {
    expect(formatDuration(START, null)).toBe("—");
    expect(formatDuration(START, null, Date.parse("2025-01-01T00:00:03Z"))).toBe("3s");
    expect(formatDuration(START, null, Date.parse("2025-01-01T00:01:45Z"))).toBe("1m 45s");
  });
});
