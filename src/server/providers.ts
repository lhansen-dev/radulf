import { getSettings, type Settings } from "./settings";
import { listAuthedModels } from "./harness";

/**
 * A provider is anything the loop runner can use. Every provider runs through
 * the one pi SDK harness (spec 13); they differ only in auth. "anthropic" uses
 * the pi Claude Pro/Max login, "chatgpt" the pi ChatGPT/OpenAI (Codex) login,
 * "copilot" the pi GitHub Copilot login, "omlx" a local models.json endpoint,
 * and "openrouter" a runtime API key.
 */
export const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude subscription)" },
  { id: "chatgpt", label: "ChatGPT (Codex subscription)" },
  { id: "copilot", label: "GitHub Copilot (subscription)" },
  { id: "omlx", label: "oMLX (local)" },
  { id: "openrouter", label: "OpenRouter" },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

export function isProviderId(x: unknown): x is ProviderId {
  return PROVIDERS.some((p) => p.id === x);
}

export function normalizeProvider(x: unknown, fallback: ProviderId): ProviderId {
  return isProviderId(x) ? x : fallback;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

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
};

/** List models a provider can serve, for the settings/card pickers. */
export async function listProviderModels(provider: ProviderId, s: Settings = getSettings()): Promise<ProviderModel[]> {
  switch (provider) {
    case "anthropic":
    case "chatgpt":
    case "copilot":
      // pi-authenticated subscriptions — one source (ModelRuntime.getAvailable).
      return listAuthedModels(provider);
    case "omlx": {
      const data = await fetchJson(
        `${s.omlxBaseUrl.replace(/\/$/, "")}/v1/models`,
        s.omlxApiKey || "omlx",
        `oMLX at ${s.omlxBaseUrl}`
      );
      const models = (data as { data?: { id: string }[] }).data ?? [];
      return models.map((m) => ({ value: m.id, displayName: m.id, description: "" }));
    }
    case "openrouter": {
      if (!s.openrouterApiKey) throw new Error("set your OpenRouter API key in Settings first");
      const data = await fetchJson(
        `${OPENROUTER_BASE_URL}/v1/models`,
        s.openrouterApiKey,
        "OpenRouter"
      );
      const models =
        (data as {
          data?: {
            id: string;
            name?: string;
            supported_parameters?: string[];
            reasoning?: { mandatory?: boolean; supported_efforts?: string[] };
          }[];
        }).data ?? [];
      // Claude Code needs tool use; hide models that can't do it.
      return models
        .filter((m) => m.supported_parameters?.includes("tools"))
        .map((m) => ({
          value: m.id,
          displayName: m.name || m.id,
          description: "",
          // OpenRouter advertises the discrete reasoning ladder per model; the
          // picker uses it to offer only levels the model honors (pi still
          // clamps, so an omitted field just means "show the full ladder").
          ...(m.reasoning?.supported_efforts
            ? { reasoningEfforts: m.reasoning.supported_efforts }
            : {}),
          ...(m.reasoning?.mandatory !== undefined
            ? { reasoningMandatory: m.reasoning.mandatory }
            : {}),
        }))
        .sort((a, b) => a.value.localeCompare(b.value));
    }
  }
}

/**
 * Verify a provider is reachable and capable of serving the given model.
 * Throws if the provider is unreachable or when `model` is non-empty but not
 * found in the provider's model list. Harness-uniform now: ModelRuntime
 * resolves provider+model and it must appear in getAvailable(). A blank model
 * (subscription default) just checks reachability. Harmless no-op on success.
 */
export async function preflightProvider(
  provider: ProviderId,
  model: string,
  s: Settings = getSettings()
): Promise<void> {
  const models = await listProviderModels(provider, s);
  if (model && !models.some((m) => m.value === model)) {
    throw new Error(
      `${provider} does not serve model "${model}" (${models.length} models available)`
    );
  }
}

async function fetchJson(url: string, bearer: string, who: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(`cannot reach ${who}: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) throw new Error(`${who} responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
