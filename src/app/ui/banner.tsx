import type { ReactNode } from "react";

const TONE = {
  red: { box: "border-red-800/60 bg-red-950/30", title: "text-red-300" },
  amber: { box: "border-amber-700/60 bg-amber-950/30", title: "text-amber-300" },
} as const;

/** A callout for something that needs the operator's attention: a toned box
 * with a heading and whatever explanation or controls belong under it. */
export function Banner({ tone, title, children }: { tone: keyof typeof TONE; title: string; children: ReactNode }) {
  return (
    <div className={`rounded-lg border p-3 text-sm ${TONE[tone].box}`}>
      <h3 className={`mb-1 font-medium ${TONE[tone].title}`}>{title}</h3>
      <div className="space-y-1 text-foreground/80">{children}</div>
    </div>
  );
}
