export type Proposal = { title: string; description: string; rationale: string };

/**
 * Render the configured PM prompt template and replace
 * `{{EXISTING_CARDS}}` with a bullet list of existing open card titles,
 * or `- (none)` when the list is empty.
 */
export function readPmPrompt(existingTitles: string[], template: string): string {
  const bulletList =
    existingTitles.length > 0
      ? existingTitles.map((t) => `- ${t}`).join("\n")
      : "- (none)";
  return template.replaceAll("{{EXISTING_CARDS}}", bulletList);
}

/**
 * Every plausible "the JSON array is in here" slice of a planner reply, best
 * candidate first. Models routinely ignore "output only JSON": two observed
 * live Improvement Run passes wrapped the array in a sentence of preamble,
 * and one wrote ```` ```json ```` *inside* a description string — which closes
 * a lazy fence match early. So we never trust a single extraction: callers try
 * these in order until one actually parses.
 *
 * 1. Fenced blocks whose body looks like an array (the documented shape).
 * 2. The outermost `[ … ]` span, which survives stray fences in prose.
 */
function jsonArrayCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:[a-zA-Z]*)?\n?([\s\S]*?)```/g)) {
    const body = match[1].trim();
    if (body.startsWith("[")) candidates.push(body);
  }
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  return candidates;
}

/**
 * Parse a planner model's JSON reply into an array of proposals.
 * Tolerates prose and markdown fences around the array (see
 * `jsonArrayCandidates`), then returns only elements that are objects with a
 * non-empty string `title` and non-empty string `description`. Missing
 * `rationale` is coerced to `""`. Capped to 3 items. Anything unparseable
 * returns `[]` (never throws).
 */
export function parseProposals(text: string): Proposal[] {
  let parsed: unknown;
  for (const candidate of jsonArrayCandidates(text)) {
    try {
      const attempt: unknown = JSON.parse(candidate);
      if (Array.isArray(attempt)) {
        parsed = attempt;
        break;
      }
    } catch {
      // Try the next candidate — a fence closed early by ``` inside a string
      // still leaves the outermost bracket span to fall back on.
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .slice(0, 3)
    .filter(
      (item: unknown): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).title === "string" &&
        (item as Record<string, unknown>).title !== "" &&
        typeof (item as Record<string, unknown>).description === "string" &&
        (item as Record<string, unknown>).description !== ""
    )
    .map((item) => ({
      title: item.title as string,
      description: item.description as string,
      rationale: typeof item.rationale === "string" ? item.rationale : "",
    }));
}
