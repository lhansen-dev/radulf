import { describe, it, expect } from "vitest";
import { formatPercent } from "./formatPercent";

describe("formatPercent", () => {
  it("renders a ratio with one decimal by default", () => {
    expect(formatPercent(0.4567)).toBe("45.7%");
    expect(formatPercent(1)).toBe("100.0%");
  });

  it("honours the digits argument", () => {
    expect(formatPercent(0.4567, 0)).toBe("46%");
  });
});
