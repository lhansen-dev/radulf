import { describeToolCall } from "../../ui/toolDescription";

/** One entry in a run's transcript, as the transcript API serves it. */
export type StreamLine = Record<string, unknown> & { t?: string };

/**
 * The plain text of a transcript line — what a reader sees when the row is
 * expanded, flattened to a string.
 *
 * One function serves both search and export on purpose: whatever a filter can
 * match, a copied transcript contains, so a search hit never disappears on the
 * way out to an editor or a bug report. Tool input is included in full rather
 * than previewed, because a file path buried in a tool call is exactly what an
 * operator is looking for when a loop went wrong on iteration 14.
 */
export function transcriptLineText(line: StreamLine): string {
  switch (line.t) {
    case "text":
      return String(line.content ?? "");
    case "reasoning":
      return `✻ reasoning: ${String(line.content ?? "(redacted by the provider)")}`;
    case "tool": {
      const name = String(line.name ?? "");
      const desc = describeToolCall(name, line.input);
      const input = line.input === undefined ? "" : JSON.stringify(line.input, null, 2) ?? "";
      return `⚒ ${name}${desc ? ` ${desc}` : ""}${input ? `\n${input}` : ""}`;
    }
    case "result":
      return line.exit === "failed"
        ? `■ result: ${String(line.detail ?? "unknown error")}`
        : "■ result: ok";
    case "usage":
      return `▸ tokens: ${String(line.inputTokens ?? 0)} in / ${String(line.outputTokens ?? 0)} out`;
    default:
      // A line kind this build does not render contributes nothing to render,
      // so it contributes nothing to search or export either.
      return "";
  }
}

/**
 * The lines a query keeps. Blank or whitespace-only matches everything, so
 * clearing the box is the same as never having filtered.
 *
 * Substring rather than regex: the thing being hunted is nearly always a path,
 * a command or an error string, and a half-typed regex silently matching the
 * wrong rows is worse than no filter at all.
 */
export function filterTranscript(lines: StreamLine[], query: string): StreamLine[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return lines;
  return lines.filter((line) => transcriptLineText(line).toLowerCase().includes(needle));
}

/** The whole transcript as text, ready for a clipboard or a `.txt` file. */
export function transcriptToText(lines: StreamLine[]): string {
  return lines.map(transcriptLineText).filter(Boolean).join("\n");
}
