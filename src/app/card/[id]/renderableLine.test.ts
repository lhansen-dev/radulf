import { describe, expect, it } from "vitest";
import { isRenderableLine } from "./renderableLine";

describe("isRenderableLine", () => {
  it("keeps every event type the transcript view draws", () => {
    for (const t of ["text", "reasoning", "tool", "result", "usage"]) {
      expect(isRenderableLine({ t })).toBe(true);
    }
  });

  it("drops raw events — they would render as blank virtualized rows", () => {
    expect(isRenderableLine({ t: "raw" })).toBe(false);
  });

  it("drops an unknown or missing type", () => {
    expect(isRenderableLine({ t: "entry_appended" })).toBe(false);
    expect(isRenderableLine({})).toBe(false);
  });
});
