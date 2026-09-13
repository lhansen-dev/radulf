import { describe, it, expect } from "vitest";
import { describeToolCall } from "./toolDescription";

describe("describeToolCall", () => {
  it.each([
    ["bash", { command: "ls -la" }, "ls -la"],
    ["BASH", { command: "npm test" }, "npm test"],
    ["Read", { file_path: "src/index.ts" }, "src/index.ts"],
    ["Edit", { file_path: "src/app/page.tsx" }, "src/app/page.tsx"],
    ["Write", { file_path: "CHANGELOG.md" }, "CHANGELOG.md"],
    ["MultiEdit", { file_path: "src/lib/util.ts" }, "src/lib/util.ts"],
    ["read", { filePath: "src/foo.ts" }, "src/foo.ts"],
    ["edit", { filePath: "src/bar.ts" }, "src/bar.ts"],
    ["write", { filePath: "src/baz.ts" }, "src/baz.ts"],
    ["Grep", { pattern: "TODO" }, "TODO"],
    ["Glob", { pattern: "**/*.test.ts" }, "**/*.test.ts"],
    ["WebFetch", { url: "https://example.com" }, "https://example.com"],
    ["Task", { description: "Do the thing" }, "Do the thing"],
    ["Task", { subject: "A task title" }, "A task title"],
    ["bash", { command: "echo hello\nworld" }, "echo hello world"],
  ])("describes %s %j", (name, input, expected) => {
    expect(describeToolCall(name, input)).toBe(expected);
  });

  it.each([
    ["Foobar", { command: "ls" }],
    ["bash", null],
    ["bash", undefined],
    ["bash", "not-an-object"],
    ["bash", 42],
    ["bash", {}],
    ["Read", { not_file_path: "x" }],
    ["bash", { command: "" }],
  ])('returns "" without throwing for %s %j', (name, input) => {
    expect(describeToolCall(name, input)).toBe("");
  });

  it("truncates long values to 120 characters plus …", () => {
    expect(describeToolCall("bash", { command: "a".repeat(200) })).toBe("a".repeat(120) + "…");
    expect(describeToolCall("Read", { file_path: "/long/" + "x".repeat(200) })).toHaveLength(121);
  });
});
