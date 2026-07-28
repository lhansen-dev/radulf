import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { resolveDocHref } from "../../server/docs";

/**
 * Render a repo doc's markdown as HTML. GFM is enabled (tables, task lists,
 * strikethrough, autolinks). Raw HTML is intentionally NOT enabled — react-
 * markdown ignores embedded HTML by default, which keeps rendering predictable
 * and avoids `dangerouslySetInnerHTML`, matching the app's posture.
 *
 * Links are rewritten via `resolveDocHref` so that cross-references between
 * docs stay inside the wiki, while everything else points at GitHub or opens
 * in a new tab.
 *
 * `rehype-slug` gives every heading a GitHub-compatible `id` (via
 * github-slugger) so in-page anchor links — the README's Table of contents,
 * for one — actually jump. The slugs match what the docs were authored for.
 */
export function MarkdownDoc({
  content,
  sourcePath,
}: {
  content: string;
  sourcePath: string;
}) {
  return (
    <div className="doc-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={{
          a: ({ href, children }: ComponentPropsWithoutRef<"a">) => {
            const resolved = resolveDocHref(sourcePath, href ?? "");
            if (resolved.external) {
              return (
                <a href={resolved.href} target="_blank" rel="noopener noreferrer">
                  {children as ReactNode}
                </a>
              );
            }
            // In-wiki route or same-page anchor — client-nav for /docs links.
            if (resolved.href.startsWith("/docs")) {
              return <Link href={resolved.href}>{children as ReactNode}</Link>;
            }
            return <a href={resolved.href}>{children as ReactNode}</a>;
          },
          // Keep wide tables from overflowing the page — scroll them locally.
          table: ({ children }: ComponentPropsWithoutRef<"table">) => (
            <div className="doc-table-wrap">
              <table>{children as ReactNode}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
