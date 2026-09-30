import { describe, expect, it } from "vitest";
import { isRenderableLine } from "./renderableLine";

describe("isRenderableLine", () => {
  it("keeps every event type the transcript view draws, dropping raw and unknown ones", () => {
    for (const t of ["text", "reasoning", "tool", "result", "usage"]) {
      expect(isRenderableLine({ t })).toBe(true);
    }
    // Raw events would render as blank virtualized rows.
    expect(isRenderableLine({ t: "raw" })).toBe(false);
    expect(isRenderableLine({ t: "entry_appended" })).toBe(false);
    expect(isRenderableLine({})).toBe(false);
  });
});
