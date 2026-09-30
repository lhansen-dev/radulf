import { describe, expect, it } from "vitest";
import { StuckDetector, stuckKey } from "./stuckDetector";

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

  it("keeps the streak across output shaping the model varies between runs", () => {
    // Observed in a real 51-minute iteration: the same test command re-run
    // eleven times, differing only in how much output it asked back.
    const d = new StuckDetector();
    const verdicts = [
      "bash tests/t.sh 2>&1",
      "bash tests/t.sh 2>&1 | head -100",
      "bash tests/t.sh | head -80",
      "bash tests/t.sh 2>&1 | tail -n 50",
    ].map((command) => d.record("bash", { command }));
    expect(verdicts).toEqual([false, false, false, true]);
  });

  it("does not merge commands that differ in more than their output shaping", () => {
    const d = new StuckDetector();
    const verdicts = ["bash a.sh | head -10", "bash b.sh | head -10", "bash a.sh", "bash a.sh"]
      .map((command) => d.record("bash", { command }));
    expect(verdicts).not.toContain(true);
  });

  it("ignores object key order", () => {
    expect(stuckKey("read", { path: "a", limit: 2 })).toBe(stuckKey("read", { limit: 2, path: "a" }));
  });

  it("respects a custom threshold", () => {
    expect(record(new StuckDetector(2), ["ls", "ls"])).toEqual([false, true]);
  });
});
