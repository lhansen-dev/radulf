/**
 * Build a model tag for a task card.
 *
 * Subscription-prefix rule: when the provider is `"anthropic"` (the Claude
 * subscription), the tag is prefixed with `claude-subscription/` so the user
 * can see at a glance that the model is billed through their subscription.
 * Other providers (oMLX, OpenRouter) are shown raw.  When `model` is null or
 * empty the card displays "default" — no tag is emitted.
 *
 * @param provider — provider id, e.g. `"anthropic" | "omlx" | "openrouter"`.
 * @param model    — resolved model alias, or null/empty for "provider default".
 * @returns The tag string, or `null` when there is no concrete model.
 */
export function modelTag(
  provider: string,
  model: string | null | undefined,
): string | null {
  if (!model) return null;
  if (provider === "anthropic") return `claude-subscription/${model}`;
  return model;
}