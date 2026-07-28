import { describe, it, expect } from "vitest";
import { parseMarkdownBlocks } from "./doneMarkdown";

describe("parseMarkdownBlocks", () => {
  it("returns [] for empty input", () => {
    expect(parseMarkdownBlocks("")).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(parseMarkdownBlocks("  \n  \n  ")).toEqual([]);
  });

  describe("headings", () => {
    it("parses h1 (#)", () => {
      const result = parseMarkdownBlocks("# Title");
      expect(result).toEqual([{ type: "heading", level: 1, text: "Title" }]);
    });

    it("parses h2 (##)", () => {
      const result = parseMarkdownBlocks("## Section");
      expect(result).toEqual([{ type: "heading", level: 2, text: "Section" }]);
    });

    it("parses h3 (###)", () => {
      const result = parseMarkdownBlocks("### Subsection");
      expect(result).toEqual([{ type: "heading", level: 3, text: "Subsection" }]);
    });

    it("parses h4 (####)", () => {
      const result = parseMarkdownBlocks("#### Sub-subsection");
      expect(result).toEqual([{ type: "heading", level: 4, text: "Sub-subsection" }]);
    });

    it("strips extra whitespace around heading text", () => {
      const result = parseMarkdownBlocks("##   padded   ");
      expect(result).toEqual([{ type: "heading", level: 2, text: "padded" }]);
    });

    it("does not treat ##### as heading (too many hashes)", () => {
      const result = parseMarkdownBlocks("##### Not a heading");
      expect(result).toEqual([{ type: "paragraph", lines: ["##### Not a heading"] }]);
    });

    it("does not treat # without space as heading", () => {
      const result = parseMarkdownBlocks("#notheading");
      expect(result).toEqual([{ type: "paragraph", lines: ["#notheading"] }]);
    });
  });

  describe("paragraphs", () => {
    it("returns a single line as a paragraph", () => {
      const result = parseMarkdownBlocks("Hello world");
      expect(result).toEqual([{ type: "paragraph", lines: ["Hello world"] }]);
    });

    it("joins consecutive non-blank, non-special lines into one paragraph", () => {
      const result = parseMarkdownBlocks("First line\nSecond line\nThird line");
      expect(result).toEqual([
        { type: "paragraph", lines: ["First line", "Second line", "Third line"] },
      ]);
    });

    it("splits paragraphs at blank lines", () => {
      const result = parseMarkdownBlocks("First paragraph\n\nSecond paragraph");
      expect(result).toEqual([
        { type: "paragraph", lines: ["First paragraph"] },
        { type: "paragraph", lines: ["Second paragraph"] },
      ]);
    });

    it("preserves original line content (not trimmed) in paragraph lines", () => {
      const result = parseMarkdownBlocks("  indented line\n  another");
      expect(result).toEqual([{ type: "paragraph", lines: ["  indented line", "  another"] }]);
    });
  });

  describe("unordered lists", () => {
    it("parses a single dash bullet", () => {
      const result = parseMarkdownBlocks("- Item one");
      expect(result).toEqual([{ type: "ul", items: ["Item one"] }]);
    });

    it("parses a single asterisk bullet", () => {
      const result = parseMarkdownBlocks("* Item one");
      expect(result).toEqual([{ type: "ul", items: ["Item one"] }]);
    });

    it("collects consecutive dash bullets", () => {
      const result = parseMarkdownBlocks("- Item one\n- Item two\n- Item three");
      expect(result).toEqual([{ type: "ul", items: ["Item one", "Item two", "Item three"] }]);
    });

    it("stops collecting when a blank line appears", () => {
      const result = parseMarkdownBlocks("- Item one\n- Item two\n\nParagraph");
      expect(result).toEqual([
        { type: "ul", items: ["Item one", "Item two"] },
        { type: "paragraph", lines: ["Paragraph"] },
      ]);
    });

    it("trims trailing whitespace from bullet text", () => {
      const result = parseMarkdownBlocks("- Item with trailing   ");
      expect(result).toEqual([{ type: "ul", items: ["Item with trailing"] }]);
    });
  });

  describe("ordered lists", () => {
    it("parses a single ordered item", () => {
      const result = parseMarkdownBlocks("1. First");
      expect(result).toEqual([{ type: "ol", items: ["First"] }]);
    });

    it("collects consecutive ordered items", () => {
      const result = parseMarkdownBlocks("1. One\n2. Two\n3. Three");
      expect(result).toEqual([{ type: "ol", items: ["One", "Two", "Three"] }]);
    });

    it("stops collecting when a non-ordered line appears", () => {
      const result = parseMarkdownBlocks("1. One\n2. Two\n\nAfter");
      expect(result).toEqual([
        { type: "ol", items: ["One", "Two"] },
        { type: "paragraph", lines: ["After"] },
      ]);
    });
  });

  describe("mixed sequences", () => {
    it("handles heading followed by paragraph", () => {
      const result = parseMarkdownBlocks("# Summary\nSome description");
      expect(result).toEqual([
        { type: "heading", level: 1, text: "Summary" },
        { type: "paragraph", lines: ["Some description"] },
      ]);
    });

    it("handles heading, paragraph, and bullets", () => {
      const input = "# Changes\n\nWhat I did:\n\n- Fixed the bug\n- Updated tests";
      const result = parseMarkdownBlocks(input);
      expect(result).toEqual([
        { type: "heading", level: 1, text: "Changes" },
        { type: "paragraph", lines: ["What I did:"] },
        { type: "ul", items: ["Fixed the bug", "Updated tests"] },
      ]);
    });

    it("handles paragraph then ordered list", () => {
      const input = "Steps:\n1. First step\n2. Second step";
      const result = parseMarkdownBlocks(input);
      expect(result).toEqual([
        { type: "paragraph", lines: ["Steps:"] },
        { type: "ol", items: ["First step", "Second step"] },
      ]);
    });

    it("handles multiple blank lines between blocks", () => {
      const input = "# A\n\n\n\n- B\n\n\n- C";
      const result = parseMarkdownBlocks(input);
      expect(result).toEqual([
        { type: "heading", level: 1, text: "A" },
        { type: "ul", items: ["B"] },
        { type: "ul", items: ["C"] },
      ]);
    });

    it("handles mixed ul and ol items", () => {
      const input = "- Bullet\n1. Numbered\n- Another bullet";
      const result = parseMarkdownBlocks(input);
      expect(result).toEqual([
        { type: "ul", items: ["Bullet"] },
        { type: "ol", items: ["Numbered"] },
        { type: "ul", items: ["Another bullet"] },
      ]);
    });
  });
});