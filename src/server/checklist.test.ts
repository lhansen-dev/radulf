import { describe, it, expect } from "vitest";
import { parseChecklist, firstUnchecked, markChecked, appendTask } from "./checklist";

const md = (...lines: string[]) => lines.join("\n");

describe("parseChecklist", () => {
  it("parses items under ## Tasks with checked state, multiline text, and 1-based line spans", () => {
    const plan = md(
      "# Context",
      "- [ ] prose dash above the heading is ignored",
      "## Tasks",
      "",
      "Descriptive prose before the first task.",
      "- [ ] Main task description",
      "  continuation line one",
      "  continuation line two",
      "- [x] Another task",
    );

    expect(parseChecklist(plan)).toEqual({
      items: [
        expect.objectContaining({
          text: "Main task description\ncontinuation line one\ncontinuation line two",
          checked: false,
          startLine: 6,
          endLine: 8,
        }),
        expect.objectContaining({ text: "Another task", checked: true, startLine: 9, endLine: 9 }),
      ],
    });
  });

  it("returns null without a ## Tasks heading", () => {
    expect(parseChecklist(md("# Plan", "- [ ] Some item"))).toBeNull();
  });

  it.each([
    ["only prose", md("## Tasks", "", "Some prose but no checklist items."), []],
    // The marker regex requires whitespace after `]`.
    ["a marker with no space after ]", md("## Tasks", "- [x]nope", "- [ ] Real task"), ["Real task"]],
    // A continuation of nothing.
    ["an indented marker with no preceding item", md("## Tasks", "  - [ ] indented", "prose"), []],
  ])("never throws on malformed input: %s", (_label, plan, texts) => {
    expect(parseChecklist(plan)!.items.map((i) => i.text)).toEqual(texts);
  });
});

describe("firstUnchecked", () => {
  it("returns the first unchecked item's number, and whether it is the last one", () => {
    expect(firstUnchecked(md("## Tasks", "- [x] Done", "- [ ] First", "- [ ] Second"))).toMatchObject({
      taskNumber: 2,
      item: { text: "First", checked: false },
      isLastUnchecked: false,
      taskCount: 3,
    });
    expect(firstUnchecked(md("## Tasks", "- [x] Done", "- [ ] Last", "- [x] Done"))).toMatchObject({
      taskNumber: 2,
      isLastUnchecked: true,
      taskCount: 3,
    });
  });

  it("returns null when every item is checked or there is no ## Tasks heading", () => {
    expect(firstUnchecked(md("## Tasks", "- [x] One", "- [x] Two"))).toBeNull();
    expect(firstUnchecked(md("# Plan", "- [ ] Orphan task"))).toBeNull();
  });
});

describe("markChecked", () => {
  it("flips only the targeted marker and preserves every other byte", () => {
    const plan = md("# Plan", "## Tasks", "- [ ] First", "- [ ] Second", "- [x] Third");
    expect(markChecked(plan, 2)).toBe(md("# Plan", "## Tasks", "- [ ] First", "- [x] Second", "- [x] Third"));
  });

  it.each([
    // The marker regex tolerates any amount of whitespace between "-" and "[";
    // markChecked must flip whatever it accepted, byte-for-byte.
    ["no space before [", md("## Tasks", "-[ ] First", "- [ ] Second"), "-[x] First\n- [ ] Second"],
    ["two spaces before [", md("## Tasks", "-  [ ] First", "- [ ] Second"), "-  [x] First\n- [ ] Second"],
  ])("flips a tolerant marker (%s) and preserves the rest of the line", (_label, plan, expectedTasksBody) => {
    expect(markChecked(plan, 1)).toBe(md("## Tasks", expectedTasksBody));
  });

  it.each([
    [md("## Tasks", "- [ ] Only one"), 2, "taskNumber 2 is out of range"],
    [md("## Tasks", "- [ ] Only one"), 0, "taskNumber 0 is out of range"],
    [md("## Tasks", "- [x] Done", "- [ ] Next"), 1, "item 1 is already checked"],
    ["# No tasks here\n", 1, "no ## Tasks section"],
  ])("throws for an invalid target (%#)", (plan, taskNumber, message) => {
    expect(() => markChecked(plan, taskNumber)).toThrow(message);
  });
});

describe("appendTask", () => {
  it("appends an unchecked item after the last task, before any following section", () => {
    const updated = appendTask(
      md("# Plan", "", "## Tasks", "- [x] First", "- [x] Second", "", "## Notes", "prose"),
      "Address the feedback",
    );
    expect(firstUnchecked(updated)).toMatchObject({
      taskNumber: 3,
      item: { text: "Address the feedback" },
      isLastUnchecked: true,
    });
    expect(updated.indexOf("- [ ] Address the feedback")).toBeLessThan(updated.indexOf("## Notes"));
  });

  it("appends at EOF as one item, keeping multiline text and dropping blank lines", () => {
    const updated = appendTask(md("## Tasks", "- [x] Only"), "First line\n\nSecond line\n");
    expect(parseChecklist(updated)!.items.map((i) => i.text)).toEqual(["Only", "First line\nSecond line"]);
  });

  it("throws without a ## Tasks section or with empty text", () => {
    expect(() => appendTask("# nothing", "task")).toThrow("no ## Tasks section");
    expect(() => appendTask("## Tasks\n- [x] Only", "\n \n")).toThrow("task text is empty");
  });
});
