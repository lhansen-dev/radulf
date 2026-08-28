import { describe, expect, it } from "vitest";
import { StuckDetector } from "./stuckDetector";

describe("StuckDetector", () => {
  it("trips true on the 4th identical tuple in a row", () => {
    const d = new StuckDetector();
    expect(d.record("bash", { cmd: "ls" })).toBe(false);
    expect(d.record("bash", { cmd: "ls" })).toBe(false);
    expect(d.record("bash", { cmd: "ls" })).toBe(false);
    expect(d.record("bash", { cmd: "ls" })).toBe(true);
  });

  it("resets the streak when a different call breaks it up", () => {
    const d = new StuckDetector();
    expect(d.record("bash", { cmd: "ls" })).toBe(false);
    expect(d.record("bash", { cmd: "ls" })).toBe(false);
    expect(d.record("bash", { cmd: "ls" })).toBe(false);
    expect(d.record("bash", { cmd: "pwd" })).toBe(false);
    expect(d.record("bash", { cmd: "ls" })).toBe(false);
    expect(d.record("bash", { cmd: "ls" })).toBe(false);
    expect(d.record("bash", { cmd: "ls" })).toBe(false);
  });

  it("never trips on interleaved distinct calls", () => {
    const d = new StuckDetector();
    for (let i = 0; i < 10; i++) {
      expect(d.record("bash", { cmd: `step-${i}` })).toBe(false);
    }
  });

  it("does not treat same tool name with different args as a repeat", () => {
    const d = new StuckDetector();
    expect(d.record("bash", { cmd: "a" })).toBe(false);
    expect(d.record("bash", { cmd: "b" })).toBe(false);
    expect(d.record("bash", { cmd: "c" })).toBe(false);
    expect(d.record("bash", { cmd: "d" })).toBe(false);
  });

  it("respects a custom threshold", () => {
    const d = new StuckDetector(2);
    expect(d.record("bash", { cmd: "ls" })).toBe(false);
    expect(d.record("bash", { cmd: "ls" })).toBe(true);
  });
});
