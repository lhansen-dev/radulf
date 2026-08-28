/**
 * "<provider>/<model> (<reasoningLevel>)" tag for a run — the raw provider id
 * plus its concrete model, or "default" when a blank model resolved to the
 * provider's subscription default; the reasoning level is appended in
 * parentheses when known. Used wherever a run's model needs to be
 * unambiguous: card overview, activity, transcript.
 */
export function formatProviderModel(
  provider: string | null | undefined,
  model: string | null | undefined,
  reasoningLevel?: string | null,
): string {
  const base = `${provider || "unknown"}/${model || "default"}`;
  return reasoningLevel ? `${base} (${reasoningLevel})` : base;
}
