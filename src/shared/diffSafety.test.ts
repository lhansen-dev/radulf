import { describe, it, expect } from "vitest";
import { findSuspiciousChars, segmentSuspiciousChars, hasSuspiciousChars } from "./diffSafety";

describe("findSuspiciousChars", () => {
  it("finds no matches in plain ASCII text", () => {
    expect(findSuspiciousChars("const x = 1; // plain line")).toEqual([]);
  });

  it("flags a right-to-left override (classic Trojan Source)", () => {
    const line = "if (isAdmin) ‮return false; //‬ allow";
    const matches = findSuspiciousChars(line);
    expect(matches.some((m) => m.kind === "bidi" && m.codePoint === 0x202e)).toBe(true);
  });

  it("flags zero-width characters", () => {
    const line = "const​token = 1";
    const matches = findSuspiciousChars(line);
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("zero-width");
  });

  it("flags Unicode tag characters", () => {
    const line = `hidden${String.fromCodePoint(0xe0041)}payload`;
    const matches = findSuspiciousChars(line);
    expect(matches.some((m) => m.kind === "tag")).toBe(true);
  });

  it("flags a Cyrillic homoglyph mixed into an ASCII identifier", () => {
    // "аdmin" — first char is Cyrillic а (U+0430), rest is ASCII.
    const line = "const аdmin = true";
    const matches = findSuspiciousChars(line);
    expect(matches.some((m) => m.kind === "confusable")).toBe(true);
  });

  it("does not flag a word entirely in another script", () => {
    // Purely Cyrillic word — normal non-English text, not spoofing.
    const line = "// комментарий на русском";
    const matches = findSuspiciousChars(line);
    expect(matches.filter((m) => m.kind === "confusable")).toEqual([]);
  });

  it("sorts matches left to right", () => {
    const line = "​a‮b";
    const matches = findSuspiciousChars(line);
    expect(matches.map((m) => m.index)).toEqual([0, 2]);
  });
});

describe("segmentSuspiciousChars", () => {
  it("returns a single text segment when nothing is suspicious", () => {
    expect(segmentSuspiciousChars("plain text")).toEqual([{ kind: "text", value: "plain text" }]);
  });

  it("splits around a suspicious character with surrounding text preserved", () => {
    const segments = segmentSuspiciousChars("ab‮cd");
    expect(segments[0]).toEqual({ kind: "text", value: "ab" });
    expect(segments[1].kind).toBe("suspicious");
    expect((segments[1] as { raw: string }).raw).toBe("‮");
    expect(segments[2]).toEqual({ kind: "text", value: "cd" });
  });

  it("round-trips: concatenating raw/value recovers the original line", () => {
    const line = "start ​middle ‮end";
    const segments = segmentSuspiciousChars(line);
    const rebuilt = segments.map((s) => (s.kind === "text" ? s.value : s.raw)).join("");
    expect(rebuilt).toBe(line);
  });
});

describe("hasSuspiciousChars", () => {
  it("is true for a bidi override, false for plain text", () => {
    expect(hasSuspiciousChars("safe")).toBe(false);
    expect(hasSuspiciousChars("un‮safe")).toBe(true);
  });
});
