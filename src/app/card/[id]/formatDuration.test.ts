// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { formatDuration } from "./formatDuration";

describe("formatDuration", () => {
  it("returns a completed range", () => {
    const result = formatDuration("2025-01-01T00:00:00Z", "2025-01-01T00:00:05Z");
    expect(result).toBe("5s");
  });

  it("returns sub-minute duration", () => {
    const result = formatDuration("2025-01-01T00:00:00Z", "2025-01-01T00:00:03Z");
    expect(result).toBe("3s");
  });

  it("returns minute+second duration", () => {
    const result = formatDuration("2025-01-01T00:00:00Z", "2025-01-01T00:02:15Z");
    expect(result).toBe("2m 15s");
  });

  it("returns em-dash when endedAt is null and nowMs is omitted", () => {
    const result = formatDuration("2025-01-01T00:00:00Z", null);
    expect(result).toBe("—");
  });

  it("returns live elapsed time when endedAt is null and nowMs is supplied", () => {
    const result = formatDuration(
      "2025-01-01T00:00:00Z",
      null,
      new Date("2025-01-01T00:00:03Z").getTime(),
    );
    expect(result).toBe("3s");
  });

  it("returns live sub-minute elapsed from nowMs", () => {
    const result = formatDuration(
      "2025-01-01T00:00:00Z",
      null,
      new Date("2025-01-01T00:00:01Z").getTime(),
    );
    expect(result).toBe("1s");
  });

  it("returns live minute+second from nowMs", () => {
    const result = formatDuration(
      "2025-01-01T00:00:00Z",
      null,
      new Date("2025-01-01T00:01:45Z").getTime(),
    );
    expect(result).toBe("1m 45s");
  });
});
