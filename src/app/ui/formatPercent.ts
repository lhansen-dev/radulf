/** A 0..1 ratio as a percentage, e.g. 0.4567 → "45.7%" (or "46%" with 0 digits). */
export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}
