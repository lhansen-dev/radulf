import { describe, it, expect } from "vitest";
import { currentTaskFromPlan, currentTaskFromFile } from "./currentTask";

describe("currentTaskFromPlan", () => {
  it("returns the first unchecked item after ## Tasks", () => {
    const md = [
      "# Plan",
      "## Tasks",
      "- [ ] First task",
      "- [ ] Second task",
    ].join("\n");
    expect(currentTaskFromPlan(md)).toBe("First task");
  });

  it("skips - [x] items and finds the first unchecked one", () => {
    const md = [
      "# Plan",
      "## Tasks",
      "- [x] Done task",
      "- [ ] Next task",
      "- [ ] Another task",
    ].join("\n");
    expect(currentTaskFromPlan(md)).toBe("Next task");
  });

  it("ignores - [ ] lines that appear before the ## Tasks heading", () => {
    const md = [
      "- [ ] This is prose in the context header, not a task",
      "## Tasks",
      "- [ ] Real task",
    ].join("\n");
    expect(currentTaskFromPlan(md)).toBe("Real task");
  });

  it("returns null when all items are checked", () => {
    const md = [
      "## Tasks",
      "- [x] First task",
      "- [x] Second task",
    ].join("\n");
    expect(currentTaskFromPlan(md)).toBeNull();
  });

  it("returns null when there is no ## Tasks section", () => {
    const md = [
      "# Plan",
      "- [ ] Some item",
      "- [ ] Another item",
    ].join("\n");
    expect(currentTaskFromPlan(md)).toBeNull();
  });

  it("returns null when ## Tasks has no items at all", () => {
    const md = "## Tasks\n";
    expect(currentTaskFromPlan(md)).toBeNull();
  });
});

describe("currentTaskFromFile", () => {
  it("returns null for a non-existent path", () => {
    expect(currentTaskFromFile("/nonexistent/path/PLAN.md")).toBeNull();
  });
});