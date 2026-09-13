import { describe, it, expect } from "vitest";
import { currentTaskFromPlan, currentTaskFromFile } from "./currentTask";

// Parsing itself is covered by checklist.test.ts; this is the thin text/file wrapper.
describe("currentTask", () => {
  it("returns the first unchecked task's text, or null when none remains or the file is missing", () => {
    expect(currentTaskFromPlan("- [ ] prose\n## Tasks\n- [x] Done\n- [ ] Next\n- [ ] Later")).toBe("Next");
    expect(currentTaskFromPlan("## Tasks\n- [x] Done")).toBeNull();
    expect(currentTaskFromFile("/nonexistent/path/PLAN.md")).toBeNull();
  });
});
