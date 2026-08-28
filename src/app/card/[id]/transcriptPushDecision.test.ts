import { describe, expect, it } from "vitest";
import { transcriptPushDecision } from "./transcriptPushDecision";

describe("transcriptPushDecision", () => {
  it("ignores a push whose cursor is not newer than the client's own", () => {
    expect(transcriptPushDecision({ fromCursor: 0, cursor: 10 }, 10, false)).toBe("ignore");
    expect(transcriptPushDecision({ fromCursor: 0, cursor: 5 }, 10, false)).toBe("ignore");
  });

  it("ignores a push with a missing/non-numeric cursor", () => {
    expect(transcriptPushDecision({ fromCursor: 0 }, 10, false)).toBe("ignore");
  });

  it("resyncs instead of applying while needsResync is true, even for a clean handoff", () => {
    expect(transcriptPushDecision({ fromCursor: 10, cursor: 20 }, 10, true)).toBe("resync");
  });

  it("applies directly on a clean handoff (fromCursor === currentCursor)", () => {
    expect(transcriptPushDecision({ fromCursor: 10, cursor: 20 }, 10, false)).toBe("apply");
  });

  it("applies directly on the very first push (fromCursor 0 === currentCursor 0)", () => {
    expect(transcriptPushDecision({ fromCursor: 0, cursor: 20 }, 0, false)).toBe("apply");
  });

  it("resyncs on overlap — fromCursor behind the client's current cursor", () => {
    expect(transcriptPushDecision({ fromCursor: 5, cursor: 20 }, 10, false)).toBe("resync");
  });

  it("resyncs on a gap — fromCursor ahead of the client's current cursor", () => {
    expect(transcriptPushDecision({ fromCursor: 15, cursor: 20 }, 10, false)).toBe("resync");
  });

  it("resyncs when fromCursor is missing/non-numeric, even with a valid newer cursor", () => {
    expect(transcriptPushDecision({ cursor: 20 }, 10, false)).toBe("resync");
  });
});
