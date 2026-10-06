"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ModelChips } from "./taskDialog";
import { inputCls, secondaryButtonCls } from "../settings/settingsUI";
import type { ProviderModel } from "@/shared/providers";
import { errorMessage } from "@/shared/errorMessage";

/**
 * The provider model picker shared by the Settings agent roles and the
 * Benchmarks launcher: a model id field backed by the provider's listing, and
 * a browser of that listing with pricing.
 */

/** $3.00 for typical prices, $0.075 for very cheap ones — 2 decimals loses
 * sub-cent-per-million models (e.g. Haiku-class) by rounding them to $0.00. */
export function formatPricePerMillion(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** "$3.00 / 1M input · $15.00 / 1M output", or "" when the provider reports no pricing. */
function priceLabel(m: ProviderModel, input = " / 1M input", output = " / 1M output", sep = " · "): string {
  return [
    m.costPerMillionInput != null && `${formatPricePerMillion(m.costPerMillionInput)}${input}`,
    m.costPerMillionOutput != null && `${formatPricePerMillion(m.costPerMillionOutput)}${output}`,
  ].filter(Boolean).join(sep);
}

const MODEL_HINTS: Record<string, string> = {
  anthropic: "Leave blank to use your subscription's default model.",
  chatgpt: "Leave blank to use your subscription's default model.",
  copilot: "Leave blank to use your subscription's default model.",
  omlx: "Use the id of a model your server reports at /v1/models; it must support tool use.",
  openrouter: "Type a model id to search the available models.",
  mock: "The model id picks a scripted scenario. Leave blank for happy-path.",
};

/** The provider's model listing, reloaded whenever the provider changes. */
export function useProviderModels(provider: string) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [status, setStatus] = useState("");

  // setState only happens in the promise callbacks, never synchronously,
  // so this is safe to call from the effect below.
  // `force` is only ever set by the "Load models" button — see the route.
  const load = useCallback((p: string, force = false, isLive: () => boolean = () => true) => {
    return api<{ models: ProviderModel[] }>(`/api/providers/${p}/models${force ? "?refresh=1" : ""}`)
      .then((r) => {
        if (!isLive()) return;
        setModels(r.models);
        setStatus(r.models.length > 0
          ? `✓ ${r.models.length} model${r.models.length === 1 ? "" : "s"}`
          : "No models found. Check your provider connection or enter a model id.");
      })
      .catch((e) => {
        if (!isLive()) return;
        setModels([]);
        setStatus(`✗ ${errorMessage(e)}`);
      });
  }, []);

  // Refresh the picker whenever the provider changes. Guard against a slow
  // provider's listing (e.g. openrouter's hundreds of models) landing after
  // the user has already switched this role to a different provider.
  useEffect(() => {
    if (!provider) return;
    let live = true;
    void load(provider, false, () => live);
    return () => { live = false; };
  }, [provider, load]);

  return { models, status, setStatus, load };
}

/** The model id field: free text, suggested from the listing, with a button
 * that bypasses the listing cache. */
export function ModelField({
  id,
  label = "Model",
  provider,
  model,
  onModel,
  models,
  onLoadModels,
  loadTitle,
}: {
  /** Prefix for the field, datalist and hint ids. */
  id: string;
  label?: string;
  provider: string;
  model: string;
  onModel: (m: string) => void;
  models: ProviderModel[];
  onLoadModels: () => void;
  loadTitle: string;
}) {
  return (
    <>
      <label htmlFor={`${id}-input`}>{label}</label>
      <div className="flex gap-2">
        <input
          id={`${id}-input`}
          aria-describedby={`${id}-hint`}
          value={model}
          onChange={(e) => onModel(e.target.value)}
          placeholder={provider === "anthropic" ? "e.g. opus" : "model id"}
          className={inputCls}
          list={id}
        />
        <datalist id={id}>
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.displayName}
            </option>
          ))}
        </datalist>
        <button
          type="button"
          onClick={onLoadModels}
          title={loadTitle}
          className={`${secondaryButtonCls} mt-2 shrink-0 whitespace-nowrap`}
        >
          Load models
        </button>
      </div>
      <p id={`${id}-hint`} className="mt-2 text-xs leading-relaxed text-foreground/45">{MODEL_HINTS[provider] ?? "Enter a model id."}</p>
    </>
  );
}

/** The picked model's pricing, the listing's load status, and a browsable
 * chip list of the listing. */
export function ModelBrowser({
  model,
  onModel,
  models,
  status,
}: {
  model: string;
  onModel: (m: string) => void;
  models: ProviderModel[];
  status: string;
}) {
  const selectedModel = models.find((m) => m.value === model);
  return (
    <>
      {selectedModel && priceLabel(selectedModel) && (
        <p className="text-xs text-foreground/40">{priceLabel(selectedModel)}</p>
      )}
      {status && !status.startsWith("✓") && (
        <p role="status" className={`text-sm ${status.startsWith("✗") ? "text-red-400" : "text-foreground/40"}`}>
          {status}
        </p>
      )}
      <ModelChips
        models={models}
        value={model}
        onPick={onModel}
        titleFor={(m) => priceLabel(m, "/1M in", "/1M out", ", ") ? `${m.description || m.value} — ${priceLabel(m, "/1M in", "/1M out", ", ")}` : m.description || m.value}
        wrap={(chips) => (
          <details className="group border-t border-foreground/10 pt-3">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-xs text-foreground/55 hover:text-foreground">
              Browse {models.length} available model{models.length === 1 ? "" : "s"}
              <span aria-hidden="true" className="transition-transform group-open:rotate-180">⌄</span>
            </summary>
            {chips}
          </details>
        )}
      />
    </>
  );
}
