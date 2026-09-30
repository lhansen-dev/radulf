import { describe, expect, it } from "vitest";
import { iterationTask } from "./iterationTask";

describe("iterationTask", () => {
  const base = { taskNumber: 3, taskCount: 15, taskText: "Add the flag" };

  it("counts a finished task as no longer left", () => {
    expect(iterationTask({ ...base, status: "completed", taskCompleted: 1 })).toEqual({
      label: "Task 3/15",
      state: "done",
      left: 12,
      text: "Add the flag",
    });
  });

  it("still counts the task while it is being worked on", () => {
    expect(iterationTask({ ...base, status: "running", taskCompleted: null })).toMatchObject({
      state: "working",
      left: 13,
    });
  });

  it("marks a finished iteration that did not tick its task off as not done", () => {
    expect(iterationTask({ ...base, status: "failed", taskCompleted: null })).toMatchObject({
      state: "not done",
      left: 13,
    });
  });

  it("returns null for iterations recorded before task tracking", () => {
    expect(iterationTask({ status: "completed" })).toBeNull();
  });
});
