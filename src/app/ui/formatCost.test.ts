import { describe, it, expect } from "vitest";
import { formatCostUsd, sumCostUsd } from "./formatCost";

describe("formatCostUsd", () => {
  it("keeps sub-cent costs visible instead of rounding them to zero", () => {
    expect(formatCostUsd(0.0123)).toBe("$0.0123");
    expect(formatCostUsd(0.00004)).toBe("$0.0000");
    expect(formatCostUsd(0.00006)).toBe("$0.0001");
  });

  it("uses the same four decimals at larger magnitudes", () => {
    expect(formatCostUsd(12.3456)).toBe("$12.3456");
    expect(formatCostUsd(1)).toBe("$1.0000");
  });

  it("distinguishes an unreported cost from a reported zero", () => {
    expect(formatCostUsd(null)).toBe("—");
    expect(formatCostUsd(undefined)).toBe("—");
    expect(formatCostUsd(0)).toBe("$0.0000");
  });

  it("renders non-finite values as unreported", () => {
    expect(formatCostUsd(Number.NaN)).toBe("—");
    expect(formatCostUsd(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("sumCostUsd", () => {
  it("sums only the reported costs", () => {
    expect(sumCostUsd([0.5, null, 0.25, undefined])).toBeCloseTo(0.75);
  });

  it("returns null when nothing reported a cost", () => {
    expect(sumCostUsd([])).toBeNull();
    expect(sumCostUsd([null, undefined])).toBeNull();
  });

  it("returns zero when zero is what was reported", () => {
    expect(sumCostUsd([0, null])).toBe(0);
  });
});
