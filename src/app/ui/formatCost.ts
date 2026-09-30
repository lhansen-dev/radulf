/**
 * Format a harness-reported USD cost for display.
 *
 * Four decimals at every magnitude: a single iteration usually costs a fraction
 * of a cent, and two decimals would render real spend as "$0.00".
 *
 * `null`/`undefined` means no cost was ever reported for the row — rendered as
 * "—" so an unmeasured run is never mistaken for a free one. A reported zero
 * (local models are registered with zero rates) formats as "$0.0000", which is
 * the truth rather than an absence.
 */
export function formatCostUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  return `$${usd.toFixed(4)}`;
}

/**
 * Sum the values that were actually reported, returning null when none were —
 * the same "don't invent a zero" rule the formatter applies, hoisted to totals
 * of cost, tokens and durations alike.
 */
export function sumReported(values: (number | null | undefined)[]): number | null {
  const reported = values.filter((v): v is number => v != null && Number.isFinite(v));
  return reported.length > 0 ? reported.reduce((sum, v) => sum + v, 0) : null;
}
