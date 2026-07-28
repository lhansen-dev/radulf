import React from "react";
import { parseMarkdownBlocks } from "./doneMarkdown";
import { renderInlineMarkdown } from "./renderInline";

interface DoneSummaryViewProps {
  done: string;
}

/**
 * Renders a markdown DONE summary as formatted React nodes inside the
 * existing violet summary box.
 *
 * Supports headings (`#`–`####`), paragraphs, unordered lists, ordered
 * lists, and inline formatting (**bold**, *italic*, `code`, [links](url)).
 * Returns `null` when the input is empty or whitespace-only.
 */
export function DoneSummaryView({ done }: DoneSummaryViewProps) {
  const trimmed = done.trim();
  if (!trimmed) return null;

  const blocks = parseMarkdownBlocks(done);

  return (
    <div className="bg-violet-950/40 border border-violet-800/50 rounded p-3 text-sm">
      <span className="font-medium text-violet-300">Loop&apos;s DONE summary</span>
      {blocks.map((block, idx) => {
        switch (block.type) {
          case "heading": {
            const Tag = `h${block.level}` as const;
            const headingClasses: Record<number, string> = {
              1: "text-lg font-semibold text-foreground/90 mt-2 mb-1",
              2: "text-base font-semibold text-foreground/90 mt-2 mb-1",
              3: "text-sm font-medium text-foreground/80 mt-1.5 mb-0.5",
              4: "text-sm font-medium text-foreground/70 mt-1.5 mb-0.5",
            };
            return (
              <Tag key={idx} className={headingClasses[block.level] ?? "text-foreground/80"}>
                {renderInlineMarkdown(block.text)}
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={idx} className="mt-1 text-foreground/80">
                {block.lines.map((line, lineIdx) => (
                  <React.Fragment key={lineIdx}>
                    {lineIdx > 0 && <br />}
                    {renderInlineMarkdown(line)}
                  </React.Fragment>
                ))}
              </p>
            );
          case "ul":
            return (
              <ul key={idx} className="mt-1 list-disc pl-5 space-y-0.5 text-foreground/80">
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInlineMarkdown(item)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={idx} className="mt-1 list-decimal pl-5 space-y-0.5 text-foreground/80">
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInlineMarkdown(item)}</li>
                ))}
              </ol>
            );
        }
      })}
    </div>
  );
}
