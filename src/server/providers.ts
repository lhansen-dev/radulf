import { getSettings, type Settings } from "./settings";
import { listAuthedModels } from "./harness";
import { fetchJson } from "./fetchJson";
import { listLocalModels, parseHeaderLines } from "./localEndpoint";
import { mockProviderModels } from "./harness/mock";

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
  /** USD per 1M tokens, when pricing is available: from pi's model catalog for
   * anthropic/chatgpt/copilot, from OpenRouter's own `/v1/models` pricing for
   * openrouter. Undefined for a self-hosted model, which has no market rate. */
  costPerMillionInput?: number;
  costPerMillionOutput?: number;
  /** Served context window, when the provider reports one (self-hosted only). */
  contextWindow?: number;
};

type ModelListCacheEntry = { models: ProviderModel[]; fetchedAt: number };

// listProviderModels is called fresh before every plan/loop/evaluate run via
// preflightProvider, but the underlying model list changes rarely — cache it
// for a short window to cut latency and rate-limit burn.
const MODEL_LIST_TTL_MS = 5 * 60 * 1000;

const modelListCache = new Map<string, ModelListCacheEntry>();

// Keyed by provider alone for anthropic/chatgpt/copilot/openrouter: their
// model list depends only on the authenticated subscription or API key, not
// on any per-call setting, and the key material itself isn't part of what's
// *listed*. omlx is the exception — s.omlxBaseUrl is a user-editable Settings
// field, not a process-wide constant, so two calls can legitimately target
// different oMLX servers; the key must include it or a cached entry from one
// endpoint would leak into a call against another.
function modelListCacheKey(provider: ProviderId, s: Settings): string {
  return provider === "omlx" ? `omlx:${s.omlxBaseUrl}` : provider;
}

/** Test-only: forget cached model lists so the next call re-fetches. */
export function resetProviderModelsCacheForTests(): void {
  modelListCache.clear();
}

/**
 * List models a provider can serve, for the settings/card pickers.
 *
 * `force` is the operator pressing "Load models": it skips this cache and, for
 * the pi-authenticated providers, the SDK's own catalog freshness window too.
 * Everything automatic (picker mount, preflight before a run) leaves it off.
 */
export async function listProviderModels(
  provider: ProviderId,
  s: Settings = getSettings(),
  opts: { force?: boolean } = {}
): Promise<ProviderModel[]> {
  const cacheKey = modelListCacheKey(provider, s);
  const cached = modelListCache.get(cacheKey);
  if (!opts.force && cached && Date.now() - cached.fetchedAt < MODEL_LIST_TTL_MS) {
    return cached.models;
  }
  const models = await fetchProviderModels(provider, s, opts.force ?? false);
  // Only successful fetches are cached — a transient outage shouldn't poison
  // the cache for the full TTL; fetchJson's own retry logic already handles
  // transient failures before we'd ever get here.
  modelListCache.set(cacheKey, { models, fetchedAt: Date.now() });
  return models;
}

async function fetchProviderModels(
  provider: ProviderId,
  s: Settings,
  force: boolean
): Promise<ProviderModel[]> {
  switch (provider) {
    case "anthropic":
    case "chatgpt":
    case "copilot":
      // pi-authenticated subscriptions — one source (ModelRuntime.getAvailable).
      return listAuthedModels(provider, { force });
    case "mock":
      return mockProviderModels();
    case "omlx": {
      const models = await listLocalModels(s.omlxBaseUrl, s.omlxApiKey, parseHeaderLines(s.omlxHeaders));
      return models.map((m) => ({
        value: m.id,
        displayName: m.id,
        description: m.contextWindow ? `${m.contextWindow.toLocaleString()} ctx` : "",
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      }));
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
            // OpenRouter reports price per single token, as decimal strings.
            pricing?: { prompt?: string; completion?: string };
          }[];
        }).data ?? [];
      // Claude Code needs tool use; hide models that can't do it.
      return models
        .filter((m) => m.supported_parameters?.includes("tools"))
        .map((m) => {
          const promptPerToken = Number(m.pricing?.prompt);
          const completionPerToken = Number(m.pricing?.completion);
          return {
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
            ...(Number.isFinite(promptPerToken) ? { costPerMillionInput: promptPerToken * 1_000_000 } : {}),
            ...(Number.isFinite(completionPerToken)
              ? { costPerMillionOutput: completionPerToken * 1_000_000 }
              : {}),
          };
        })
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
