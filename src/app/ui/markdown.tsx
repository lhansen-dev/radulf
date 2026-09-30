import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Compact Markdown for agent-written text: GFM, no raw HTML, list and code
 * styling only. react-markdown's default `urlTransform` empties any href whose
 * scheme is not http(s)/mailto, so a `[x](javascript:…)` link is inert. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="flex flex-col gap-1.5 [&_code]:rounded [&_code]:bg-foreground/10 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }: ComponentPropsWithoutRef<"h1">) => <p className="font-semibold">{children as ReactNode}</p>,
          h2: ({ children }: ComponentPropsWithoutRef<"h2">) => <p className="font-semibold">{children as ReactNode}</p>,
          h3: ({ children }: ComponentPropsWithoutRef<"h3">) => <p className="font-medium">{children as ReactNode}</p>,
          ul: ({ children }: ComponentPropsWithoutRef<"ul">) => <ul className="list-disc space-y-0.5 pl-5">{children as ReactNode}</ul>,
          ol: ({ children }: ComponentPropsWithoutRef<"ol">) => <ol className="list-decimal space-y-0.5 pl-5">{children as ReactNode}</ol>,
          pre: ({ children }: ComponentPropsWithoutRef<"pre">) => <pre className="overflow-x-auto rounded bg-foreground/[0.06] p-2 text-xs [&_code]:bg-transparent [&_code]:p-0">{children as ReactNode}</pre>,
          a: ({ href, children }: ComponentPropsWithoutRef<"a">) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-amber-300 underline">{children as ReactNode}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
