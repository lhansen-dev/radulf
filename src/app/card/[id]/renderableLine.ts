/**
 * Which transcript event types the transcript view actually draws.
 *
 * The runner writes *every* normalized event to the JSONL file, including
 * `t:"raw"` — the catch-all for pi SDK events the normalizer doesn't map
 * (`entry_appended`, `tool_execution_end`, `queue_update`, `agent_settled`,
 * compaction/session framing, …). Those are frequent: a single tool call
 * produces several. `TranscriptLine` renders nothing for them, but a
 * virtualized row that renders nothing is not free — react-window's
 * `useDynamicRowHeight` ignores a measured block size of 0 (it only records
 * truthy heights), so an empty row keeps the pre-measurement estimate
 * forever and shows up as a `defaultRowHeight`-tall blank gap. A run's worth
 * of raw events therefore reads as big blank sections between the lines that
 * do render.
 *
 * The fix is to never hand an undrawable line to the list. Filtering happens
 * at ingest so the stored array is exactly what's on screen: row indices,
 * `MAX_TRANSCRIPT_LINES`, the scroll-to-latest target, and the "Jump to
 * latest" prompt all stay in step with what the user sees. Raw events stay
 * on disk and in the API response — this only decides what gets drawn.
 */
const RENDERABLE_TYPES = new Set(["text", "reasoning", "tool", "result", "usage"]);

export function isRenderableLine(line: { t?: string }): boolean {
  return typeof line.t === "string" && RENDERABLE_TYPES.has(line.t);
}
