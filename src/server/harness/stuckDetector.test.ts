import { describe, expect, it } from "vitest";
import { StuckDetector } from "./stuckDetector";

/** Record each call and return what the detector said after each one. */
function record(d: StuckDetector, cmds: string[]): boolean[] {
  return cmds.map((cmd) => d.record("bash", { cmd }));
}

describe("StuckDetector", () => {
  it("trips on the 4th identical call in a row, and a different call resets the streak", () => {
    expect(record(new StuckDetector(), ["ls", "ls", "ls", "ls"])).toEqual([false, false, false, true]);
    expect(record(new StuckDetector(), ["ls", "ls", "ls", "pwd", "ls", "ls", "ls"])).not.toContain(true);
  });

  it("never trips when the same tool is called with different args", () => {
    expect(record(new StuckDetector(), Array.from({ length: 10 }, (_, i) => `step-${i}`))).not.toContain(true);
  });

  it("respects a custom threshold", () => {
    expect(record(new StuckDetector(2), ["ls", "ls"])).toEqual([false, true]);
  });
});
