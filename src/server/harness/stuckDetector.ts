/**
 * Detects an agent repeating the exact same tool call over and over within a
 * single iteration — the gap consecutiveStalls (orchestrator.ts) doesn't
 * cover, since that only compares progress *between* completed iterations.
 */
export class StuckDetector {
  private lastKey: string | null = null;
  private streak = 0;
  constructor(private readonly threshold = 4) {}

  /** Feed one tool-call event; returns true the moment the threshold is hit.
   * Keys on `JSON.stringify(input)`, so two calls with the same tool name
   * but differently-ordered object keys won't be recognized as repeats —
   * a known limitation, not worth a deep-equal for this heuristic. */
  record(name: string, input: unknown): boolean {
    const key = `${name}:${JSON.stringify(input)}`;
    this.streak = key === this.lastKey ? this.streak + 1 : 1;
    this.lastKey = key;
    return this.streak >= this.threshold;
  }
}
