import { describe, expect, it } from "vitest";
import { transcriptPushDecision } from "./transcriptPushDecision";

describe("transcriptPushDecision", () => {
  it.each([
    ["a cursor no newer than the client's", { fromCursor: 0, cursor: 10 }, 10, false, "ignore"],
    ["an older cursor", { fromCursor: 0, cursor: 5 }, 10, false, "ignore"],
    ["a missing cursor", { fromCursor: 0 }, 10, false, "ignore"],
    ["a clean handoff (fromCursor === current)", { fromCursor: 10, cursor: 20 }, 10, false, "apply"],
    ["the very first push", { fromCursor: 0, cursor: 20 }, 0, false, "apply"],
    ["a clean handoff while needsResync is set", { fromCursor: 10, cursor: 20 }, 10, true, "resync"],
    ["an overlap (fromCursor behind)", { fromCursor: 5, cursor: 20 }, 10, false, "resync"],
    ["a gap (fromCursor ahead)", { fromCursor: 15, cursor: 20 }, 10, false, "resync"],
    ["a missing fromCursor", { cursor: 20 }, 10, false, "resync"],
  ])("given %s → %s", (_label, push, current, needsResync, expected) => {
    expect(transcriptPushDecision(push, current, needsResync)).toBe(expected);
  });
});
