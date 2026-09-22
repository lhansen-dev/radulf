/**
 * Detects an agent repeating the same tool call over and over within a
 * single iteration — the gap consecutiveStalls (orchestrator.ts) doesn't
 * cover, since that only compares progress *between* completed iterations.
 */

/** Output shaping a model varies while re-running one command: `2>&1`, and
 * `| head -100` / `| tail -n 50` to trim what it reads back. None of it makes
 * the command a different command, so none of it may reset the streak. */
const OUTPUT_SHAPING = /\s*(?:2>&1|\|\s*(?:head|tail)(?:\s+-n)?\s+-?\d+)/g;

/** JSON with object keys in a stable order, so two calls that differ only in
 * key order compare equal. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : val,
  );
}

/** The identity of a tool call for repeat-detection purposes. */
export function stuckKey(name: string, input: unknown): string {
  if (name === "bash" && input && typeof input === "object") {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") {
      return `bash:${command.replace(OUTPUT_SHAPING, "").replace(/\s+/g, " ").trim()}`;
    }
  }
  return `${name}:${stableJson(input)}`;
}

export class StuckDetector {
  private lastKey: string | null = null;
  private streak = 0;
  constructor(private readonly threshold = 4) {}

  /** Feed one tool-call event; returns true the moment the threshold is hit.
   * Only *consecutive* repeats count. Widening this to a sliding window was
   * measured against 18 recorded iterations and killed 2 of the 14 that went
   * on to complete their task, so the streak stays. */
  record(name: string, input: unknown): boolean {
    const key = stuckKey(name, input);
    this.streak = key === this.lastKey ? this.streak + 1 : 1;
    this.lastKey = key;
    return this.streak >= this.threshold;
  }
}
