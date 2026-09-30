import { Markdown } from "../../ui/markdown";

/**
 * The loop's DONE summary, rendered as Markdown inside the violet summary
 * box. Returns `null` when the input is empty or whitespace-only.
 */
export function DoneSummaryView({ done }: { done: string }) {
  if (!done.trim()) return null;

  return (
    <div className="bg-violet-950/40 border border-violet-800/50 rounded p-3 text-sm">
      <span className="font-medium text-violet-300">Loop&apos;s DONE summary</span>
      <div className="mt-1 text-foreground/80">
        <Markdown>{done}</Markdown>
      </div>
    </div>
  );
}
