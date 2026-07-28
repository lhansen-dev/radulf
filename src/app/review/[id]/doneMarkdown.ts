export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

/**
 * Parse a markdown string into an array of typed blocks.
 *
 * Supports headings (`#`–`####`), paragraphs (consecutive non-blank,
 * non-special lines), unordered lists (`- ` / `* `), and ordered lists
 * (`1. `). Blank lines separate blocks. Empty/whitespace-only input
 * returns `[]`.
 */
export function parseMarkdownBlocks(done: string): MarkdownBlock[] {
  const rawLines = done.split("\n");
  const blocks: MarkdownBlock[] = [];

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();

    // Skip blank lines
    if (trimmed === "") {
      i++;
      continue;
    }

    // Heading: # to ####
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length as 1 | 2 | 3 | 4,
        text: headingMatch[2].trim(),
      });
      i++;
      continue;
    }

    // Unordered list: - or *
    const ulMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      const items: string[] = [ulMatch[1].trim()];
      i++;
      // Consume consecutive UL items
      while (i < rawLines.length) {
        const nextTrimmed = rawLines[i].trim();
        if (nextTrimmed === "") break;
        const nextUl = nextTrimmed.match(/^[-*]\s+(.*)$/);
        if (!nextUl) break;
        items.push(nextUl[1].trim());
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // Ordered list: 1. 2. etc.
    const olMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      const items: string[] = [olMatch[1].trim()];
      i++;
      // Consume consecutive OL items
      while (i < rawLines.length) {
        const nextTrimmed = rawLines[i].trim();
        if (nextTrimmed === "") break;
        const nextOl = nextTrimmed.match(/^\d+\.\s+(.*)$/);
        if (!nextOl) break;
        items.push(nextOl[1].trim());
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // Paragraph: collect consecutive non-blank, non-special lines
    const lines: string[] = [line];
    i++;
    while (i < rawLines.length) {
      const nextLine = rawLines[i];
      const nextTrimmed = nextLine.trim();
      if (nextTrimmed === "") break;
      // If it looks like a heading or list item, stop
      if (
        /^(#{1,4})\s/.test(nextTrimmed) ||
        /^[-*]\s/.test(nextTrimmed) ||
        /^\d+\.\s/.test(nextTrimmed)
      ) {
        break;
      }
      lines.push(nextLine);
      i++;
    }
    blocks.push({ type: "paragraph", lines });
  }

  return blocks;
}