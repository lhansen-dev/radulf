import { describe, it, expect } from "vitest";
import { describeToolCall } from "./toolDescription";

describe("describeToolCall", () => {
  // --- Bash ---
  it("returns the bash command", () => {
    expect(describeToolCall("bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("is case-insensitive for Bash vs bash", () => {
    expect(describeToolCall("Bash", { command: "npm test" })).toBe("npm test");
    expect(describeToolCall("BASH", { command: "npm test" })).toBe("npm test");
  });

  // --- Read / Edit / Write / MultiEdit ---
  it("returns file_path for Read", () => {
    expect(describeToolCall("Read", { file_path: "src/index.ts" })).toBe(
      "src/index.ts",
    );
  });

  it("returns file_path for Edit", () => {
    expect(describeToolCall("Edit", { file_path: "src/app/page.tsx" })).toBe(
      "src/app/page.tsx",
    );
  });

  it("returns file_path for Write", () => {
    expect(describeToolCall("Write", { file_path: "CHANGELOG.md" })).toBe(
      "CHANGELOG.md",
    );
  });

  it("returns file_path for MultiEdit", () => {
    expect(describeToolCall("MultiEdit", { file_path: "src/lib/util.ts" })).toBe(
      "src/lib/util.ts",
    );
  });

  it("accepts camelCase filePath for Read/Edit/Write", () => {
    expect(describeToolCall("read", { filePath: "src/foo.ts" })).toBe(
      "src/foo.ts",
    );
    expect(describeToolCall("edit", { filePath: "src/bar.ts" })).toBe(
      "src/bar.ts",
    );
    expect(describeToolCall("write", { filePath: "src/baz.ts" })).toBe(
      "src/baz.ts",
    );
  });

  // --- Grep / Glob ---
  it("returns the pattern for Grep", () => {
    expect(describeToolCall("Grep", { pattern: "TODO" })).toBe("TODO");
  });

  it("returns the pattern for Glob", () => {
    expect(
      describeToolCall("Glob", { pattern: "**/*.test.ts" }),
    ).toBe("**/*.test.ts");
  });

  // --- WebFetch ---
  it("returns the url for WebFetch", () => {
    expect(
      describeToolCall("WebFetch", { url: "https://example.com" }),
    ).toBe("https://example.com");
  });

  // --- Task ---
  it("returns the description for Task", () => {
    expect(
      describeToolCall("Task", { description: "Do the thing" }),
    ).toBe("Do the thing");
  });

  it("picks subject when description is missing for Task", () => {
    expect(describeToolCall("Task", { subject: "A task title" })).toBe(
      "A task title",
    );
  });

  // --- Unknown tool ---
  it('returns "" for unknown tool names', () => {
    expect(describeToolCall("Foobar", { command: "ls" })).toBe("");
    expect(describeToolCall("UnknownTool", { something: "x" })).toBe("");
  });

  // --- Defensive input handling ---
  it('returns "" for null input without throwing', () => {
    expect(describeToolCall("bash", null)).toBe("");
  });

  it('returns "" for undefined input without throwing', () => {
    expect(describeToolCall("bash", undefined)).toBe("");
  });

  it('returns "" for non-object input (string) without throwing', () => {
    expect(describeToolCall("bash", "not-an-object")).toBe("");
  });

  it('returns "" for non-object input (number) without throwing', () => {
    expect(describeToolCall("bash", 42)).toBe("");
  });

  // --- Missing fields ---
  it('returns "" when the expected field is missing', () => {
    expect(describeToolCall("bash", {})).toBe("");
    expect(describeToolCall("Read", { not_file_path: "x" })).toBe("");
  });

  it('returns "" when the expected field is an empty string', () => {
    expect(describeToolCall("bash", { command: "" })).toBe("");
  });

  // --- Truncation ---
  it("truncates long commands with a trailing …", () => {
    const long = "a".repeat(200);
    const result = describeToolCall("bash", { command: long });
    expect(result).toBe("a".repeat(120) + "…");
    expect(result.length).toBe(121);
  });

  it("truncates long file paths with a trailing …", () => {
    const long = "/this/is/a/very/long/path/" + "x".repeat(100);
    const result = describeToolCall("Read", { file_path: long });
    expect(result.length).toBe(121);
    expect(result.endsWith("…")).toBe(true);
  });

  // --- Newline cleaning ---
  it("replaces newlines with spaces", () => {
    expect(
      describeToolCall("bash", { command: "echo hello\nworld" }),
    ).toBe("echo hello world");
  });
});