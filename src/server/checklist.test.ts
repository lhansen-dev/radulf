import { describe, it, expect } from "vitest";
import { parseChecklist, firstUnchecked, markChecked, appendTask } from "./checklist";

describe("parseChecklist", () => {
  it("parses a simple two-item list with one checked and one unchecked", () => {
    const md = [
      "# Plan",
      "## Tasks",
      "- [x] Done task",
      "- [ ] Next task",
    ].join("\n");

    const result = parseChecklist(md);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(2);

    // First item: checked
    expect(result!.items[0].text).toBe("Done task");
    expect(result!.items[0].checked).toBe(true);
    expect(result!.items[0].startLine).toBe(3); // 1-based
    expect(result!.items[0].endLine).toBe(3);

    // Second item: unchecked
    expect(result!.items[1].text).toBe("Next task");
    expect(result!.items[1].checked).toBe(false);
    expect(result!.items[1].startLine).toBe(4);
    expect(result!.items[1].endLine).toBe(4);
  });

  it("returns null when there is no ## Tasks heading", () => {
    const md = [
      "# Plan",
      "- [ ] Some item",
      "- [ ] Another item",
    ].join("\n");

    expect(parseChecklist(md)).toBeNull();
  });

  it("parses a multiline item spanning three lines with continuation", () => {
    const md = [
      "# Plan",
      "## Tasks",
      "- [ ] Main task description",
      "  continuation line one",
      "  continuation line two",
      "- [x] Another task",
    ].join("\n");

    const result = parseChecklist(md);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(2);

    // First item: unchecked with multiline text
    expect(result!.items[0].text).toBe("Main task description\ncontinuation line one\ncontinuation line two");
    expect(result!.items[0].checked).toBe(false);
    expect(result!.items[0].startLine).toBe(3);
    expect(result!.items[0].endLine).toBe(5);

    // Second item: checked single-line
    expect(result!.items[1].text).toBe("Another task");
    expect(result!.items[1].checked).toBe(true);
    expect(result!.items[1].startLine).toBe(6);
    expect(result!.items[1].endLine).toBe(6);
  });

  it("ignores dashed prose above ## Tasks heading (prose-with-dashes fixture)", () => {
    const md = [
      "# Context",
      "- [ ] prose item that should be ignored",
      "- [x] more prose that should also be ignored",
      "Some regular prose.",
      "## Tasks",
      "- [ ] Real task one",
      "- [x] Real task two",
    ].join("\n");

    const result = parseChecklist(md);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(2);
    expect(result!.items[0].text).toBe("Real task one");
    expect(result!.items[0].checked).toBe(false);
    expect(result!.items[0].startLine).toBe(6);
    expect(result!.items[0].endLine).toBe(6);
    expect(result!.items[1].text).toBe("Real task two");
    expect(result!.items[1].checked).toBe(true);
    expect(result!.items[1].startLine).toBe(7);
    expect(result!.items[1].endLine).toBe(7);

    // firstUnchecked should find the real task, not the prose dashes
    const unchecked = firstUnchecked(md);
    expect(unchecked).not.toBeNull();
    expect(unchecked!.taskNumber).toBe(1);
    expect(unchecked!.item.text).toBe("Real task one");
  });

  it("zero unchecked items fixture: all checked returns null from firstUnchecked", () => {
    const md = [
      "# Plan",
      "## Tasks",
      "- [x] Task one",
      "- [x] Task two",
      "- [x] Task three",
    ].join("\n");

    const parsed = parseChecklist(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.items).toHaveLength(3);
    expect(parsed!.items.every((i) => i.checked)).toBe(true);

    expect(firstUnchecked(md)).toBeNull();
  });

  it("returns { items: [] } when ## Tasks section has zero items", () => {
    const md = [
      "# Plan",
      "## Tasks",
      "",
      "Some prose but no checklist items.",
    ].join("\n");

    const result = parseChecklist(md);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(0);
  });

  it("malformed: - [x]nope without space after ] is NOT a task (marker regex requires \\s+ after ])", () => {
    const md = [
      "## Tasks",
      "- [x]nope",
      "- [ ] Real task",
    ].join("\n");

    const result = parseChecklist(md);
    expect(result).not.toBeNull();
    // First line is not a valid task marker because there's no space after ]
    // Only the real task should be parsed
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].text).toBe("Real task");
    expect(result!.items[0].checked).toBe(false);
    // parseChecklist must never throw
    expect(() => parseChecklist(md)).not.toThrow();
  });

  it("malformed: nested/indented checklist marker with no preceding item yields zero items", () => {
    const md = [
      "## Tasks",
      "  - [ ] indented marker with no preceding item",
      "Just some prose.",
    ].join("\n");

    const result = parseChecklist(md);
    expect(result).not.toBeNull();
    // The indented marker is treated as a continuation of nothing
    // and yields zero items
    expect(result!.items).toHaveLength(0);
    // parseChecklist must never throw
    expect(() => parseChecklist(md)).not.toThrow();
  });

  it("malformed: prose between ## Tasks heading and real task still parses the real task", () => {
    const md = [
      "## Tasks",
      "",
      "Here is some descriptive prose that is not a task.",
      "It spans multiple lines and explains the context.",
      "",
      "- [ ] The real task after the prose",
    ].join("\n");

    const result = parseChecklist(md);
    expect(result).not.toBeNull();
    // Only the real task marker should be parsed
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].text).toBe("The real task after the prose");
    expect(result!.items[0].checked).toBe(false);
    expect(result!.items[0].startLine).toBe(6);
    expect(result!.items[0].endLine).toBe(6);
    // parseChecklist must never throw
    expect(() => parseChecklist(md)).not.toThrow();
  });
});

describe("firstUnchecked", () => {
  it("returns the first unchecked item with correct taskNumber and text", () => {
    const md = [
      "# Plan",
      "## Tasks",
      "- [x] Done task",
      "- [ ] First unchecked",
      "- [ ] Second unchecked",
    ].join("\n");

    const result = firstUnchecked(md);
    expect(result).not.toBeNull();
    expect(result!.taskNumber).toBe(2);
    expect(result!.item.text).toBe("First unchecked");
    expect(result!.item.checked).toBe(false);
  });

  it("returns null when all items are checked", () => {
    const md = [
      "# Plan",
      "## Tasks",
      "- [x] Task one",
      "- [x] Task two",
    ].join("\n");

    expect(firstUnchecked(md)).toBeNull();
  });

  it("returns null when ## Tasks heading is missing", () => {
    const md = [
      "# Plan",
      "- [ ] Orphan task",
    ].join("\n");

    expect(firstUnchecked(md)).toBeNull();
  });

  it("reports isLastUnchecked: true for the sole remaining unchecked item", () => {
    const md = [
      "# Plan",
      "## Tasks",
      "- [x] Done",
      "- [ ] Last unchecked",
    ].join("\n");

    const result = firstUnchecked(md);
    expect(result).not.toBeNull();
    expect(result!.taskNumber).toBe(2);
    expect(result!.isLastUnchecked).toBe(true);
  });

  it("reports isLastUnchecked: false when another unchecked follows", () => {
    const md = [
      "# Plan",
      "## Tasks",
      "- [ ] First unchecked",
      "- [ ] Second unchecked",
      "- [x] Done",
    ].join("\n");

    const result = firstUnchecked(md);
    expect(result).not.toBeNull();
    expect(result!.taskNumber).toBe(1);
    expect(result!.isLastUnchecked).toBe(false);
  });
});

describe("markChecked", () => {
  it("flips an unchecked marker to [x] and preserves all other bytes", () => {
    const md = [
      "# Plan",
      "## Tasks",
      "- [ ] Task to check",
      "- [x] Already done",
    ].join("\n");

    const result = markChecked(md, 1);

    // Verify the marker flipped
    expect(result).toContain("- [x] Task to check");

    // Verify the other item is untouched
    expect(result).toContain("- [x] Already done");

    // Verify byte count is preserved (same length since [ ] and [x] are both 3 chars)
    expect(result.length).toBe(md.length);

    // Verify snapshot — should differ only in the marker
    const expectedLines = [
      "# Plan",
      "## Tasks",
      "- [x] Task to check",
      "- [x] Already done",
    ];
    expect(result).toBe(expectedLines.join("\n"));
  });

  it("marking the second of three items leaves items 1 and 3 untouched", () => {
    const md = [
      "## Tasks",
      "- [ ] First",
      "- [ ] Second",
      "- [ ] Third",
    ].join("\n");

    const result = markChecked(md, 2);

    const lines = result.split("\n");
    expect(lines[0]).toBe("## Tasks");
    expect(lines[1]).toBe("- [ ] First");
    expect(lines[2]).toBe("- [x] Second");
    expect(lines[3]).toBe("- [ ] Third");
  });

  it("throws when taskNumber is out of range (too high)", () => {
    const md = [
      "## Tasks",
      "- [ ] Only one",
    ].join("\n");

    expect(() => markChecked(md, 2)).toThrow(
      "taskNumber 2 is out of range",
    );
  });

  it("throws when taskNumber is out of range (zero)", () => {
    const md = [
      "## Tasks",
      "- [ ] Only one",
    ].join("\n");

    expect(() => markChecked(md, 0)).toThrow(
      "taskNumber 0 is out of range",
    );
  });

  it("throws when the item is already checked", () => {
    const md = [
      "## Tasks",
      "- [x] Already done",
      "- [ ] Next task",
    ].join("\n");

    expect(() => markChecked(md, 1)).toThrow(
      "item 1 is already checked",
    );
  });

  it("throws when plan has no ## Tasks section", () => {
    const md = "# No tasks here\n";
    expect(() => markChecked(md, 1)).toThrow(
      "no ## Tasks section",
    );
  });
});
describe("appendTask", () => {
  it("appends an unchecked item after the last task", () => {
    const md = [
      "# Plan",
      "",
      "## Tasks",
      "- [x] First",
      "- [x] Second",
      "",
      "## Notes",
      "prose",
    ].join("\n");

    const updated = appendTask(md, "Address the feedback");
    const task = firstUnchecked(updated);
    expect(task?.taskNumber).toBe(3);
    expect(task?.item.text).toBe("Address the feedback");
    expect(task?.isLastUnchecked).toBe(true);
    // The Notes section is untouched and still follows the new item.
    expect(updated.indexOf("- [ ] Address the feedback")).toBeLessThan(
      updated.indexOf("## Notes"),
    );
  });

  it("appends at EOF when ## Tasks is the last section", () => {
    const md = ["## Tasks", "- [x] Only"].join("\n");
    const updated = appendTask(md, "New task");
    expect(firstUnchecked(updated)?.item.text).toBe("New task");
  });

  it("keeps multiline text one item and drops blank lines", () => {
    const md = ["## Tasks", "- [x] Only"].join("\n");
    const updated = appendTask(md, "First line\n\nSecond line\n");
    const task = firstUnchecked(updated);
    expect(task?.item.text).toBe("First line\nSecond line");
    expect(parseChecklist(updated)?.items).toHaveLength(2);
  });

  it("throws when the plan has no ## Tasks section", () => {
    expect(() => appendTask("# nothing", "task")).toThrow("no ## Tasks section");
  });

  it("throws when the task text is empty", () => {
    expect(() => appendTask("## Tasks\n- [x] Only", "\n \n")).toThrow("task text is empty");
  });
});
