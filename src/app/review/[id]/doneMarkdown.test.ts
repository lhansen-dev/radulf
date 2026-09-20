import { describe, it, expect } from "vitest";
import { parseMarkdownBlocks } from "./doneMarkdown";

describe("parseMarkdownBlocks", () => {
  it.each(["", "  \n  \n  "])("returns [] for blank input %j", (input) => {
    expect(parseMarkdownBlocks(input)).toEqual([]);
  });

  it("parses h1–h4 headings, trimming their text", () => {
    expect(parseMarkdownBlocks("# One\n##   Two   \n### Three\n#### Four")).toEqual([
      { type: "heading", level: 1, text: "One" },
      { type: "heading", level: 2, text: "Two" },
      { type: "heading", level: 3, text: "Three" },
      { type: "heading", level: 4, text: "Four" },
    ]);
  });

  it.each(["##### Too many hashes", "#nospace"])("treats %j as a paragraph, not a heading", (line) => {
    expect(parseMarkdownBlocks(line)).toEqual([{ type: "paragraph", lines: [line] }]);
  });

  it("joins consecutive lines into paragraphs, untrimmed, split at blank lines", () => {
    expect(parseMarkdownBlocks("  First line\n  second line\n\nNext paragraph")).toEqual([
      { type: "paragraph", lines: ["  First line", "  second line"] },
      { type: "paragraph", lines: ["Next paragraph"] },
    ]);
  });

  it("collects dash/asterisk bullets and ordered items, trimming trailing whitespace", () => {
    expect(parseMarkdownBlocks("- One   \n* Two\n\nAfter\n1. First\n2. Second\n\nEnd")).toEqual([
      { type: "ul", items: ["One", "Two"] },
      { type: "paragraph", lines: ["After"] },
      { type: "ol", items: ["First", "Second"] },
      { type: "paragraph", lines: ["End"] },
    ]);
  });

  it("starts a new block when the kind changes or after blank lines", () => {
    expect(parseMarkdownBlocks("# Changes\nWhat I did:\n- Bullet\n1. Numbered\n- Another\n\n\n\n- Separate")).toEqual([
      { type: "heading", level: 1, text: "Changes" },
      { type: "paragraph", lines: ["What I did:"] },
      { type: "ul", items: ["Bullet"] },
      { type: "ol", items: ["Numbered"] },
      { type: "ul", items: ["Another"] },
      { type: "ul", items: ["Separate"] },
    ]);
  });
});
