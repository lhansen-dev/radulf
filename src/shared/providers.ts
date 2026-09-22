/**
 * A provider is anything the loop runner can use. Every provider runs through
 * the one pi SDK harness (spec 13); they differ only in auth. "anthropic" uses
 * the pi Claude Pro/Max login, "chatgpt" the pi ChatGPT/OpenAI (Codex) login,
 * "copilot" the pi GitHub Copilot login, "omlx" a self-hosted OpenAI-compatible
 * endpoint, and "openrouter" a runtime API key. "mock" is a scripted stand-in
 * for testing (harness/mock.ts) — no model is called, and it works only on a
 * server started with RADULF_MOCK_LLM=1.
 */
export const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude subscription)" },
  { id: "chatgpt", label: "ChatGPT (Codex subscription)" },
  { id: "copilot", label: "GitHub Copilot (subscription)" },
  { id: "omlx", label: "Local / self-hosted (OpenAI-compatible)" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "mock", label: "Mock (scripted, no model)" },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

export function providerLabel(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

// pi's thinking levels (pi --thinking): the full ladder pi accepts. Pi clamps
// an unsupported level to the nearest one the chosen model supports.
export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type ProviderModel = {
  value: string;
  displayName: string;
  description: string;
  /** Reasoning efforts this model actually supports (OpenRouter only; other
   * providers leave it undefined, and the picker falls back to the full
   * ladder). Ordered as the provider reports them. */
  reasoningEfforts?: string[];
  /** True when reasoning cannot be turned off — the picker then omits "off". */
  reasoningMandatory?: boolean;
  /** USD per 1M tokens, when pricing is available: from pi's model catalog for
   * anthropic/chatgpt/copilot, from OpenRouter's own `/v1/models` pricing for
   * openrouter. Undefined for a self-hosted model, which has no market rate. */
  costPerMillionInput?: number;
  costPerMillionOutput?: number;
  /** Served context window, when the provider reports one (self-hosted only). */
  contextWindow?: number;
};
