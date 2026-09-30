import { describe, it, expect } from "vitest";
import { formatCostUsd, sumReported } from "./formatCost";

describe("formatCostUsd", () => {
  it("always shows four decimals, so sub-cent costs stay visible", () => {
    expect(formatCostUsd(0.0123)).toBe("$0.0123");
    expect(formatCostUsd(0.00004)).toBe("$0.0000");
    expect(formatCostUsd(0.00006)).toBe("$0.0001");
    expect(formatCostUsd(12.3456)).toBe("$12.3456");
    expect(formatCostUsd(1)).toBe("$1.0000");
  });

  it("distinguishes an unreported (or non-finite) cost from a reported zero", () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatCostUsd(v)).toBe("—");
    }
    expect(formatCostUsd(0)).toBe("$0.0000");
  });
});

describe("sumReported", () => {
  it("sums only reported costs, returning null when nothing was reported", () => {
    expect(sumReported([0.5, null, 0.25, undefined])).toBeCloseTo(0.75);
    expect(sumReported([0, null])).toBe(0);
    expect(sumReported([])).toBeNull();
    expect(sumReported([null, undefined])).toBeNull();
  });
});
