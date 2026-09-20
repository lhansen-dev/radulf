/**
 * Helpers for the self-hosted, OpenAI-compatible endpoint behind the `omlx`
 * provider id: oMLX on a Mac, vLLM in a lab, LM Studio, anything that serves
 * `/v1/models` and `/v1/chat/completions`.
 *
 * Two callers need the same URL and the same model metadata: the settings
 * pickers (`listProviderModels`) and the pi provider block (`omlxProviderConfig`).
 * They live here rather than in either one because `providers.ts` imports the
 * harness and the harness would otherwise have to import `providers.ts` back.
 */

import { fetchJson } from "./fetchJson";

/**
 * Normalize the configured base URL to its `/v1` root.
 *
 * Settings documents the field as the server root (`http://host:8000`), but
 * `http://host:8000/v1` is what every vLLM and LM Studio README prints, so a
 * trailing `/v1` is stripped before it is re-appended. Both spellings work.
 */
export function v1Root(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
}

/** One entry of an OpenAI-compatible `/v1/models` response. */
export type LocalModel = {
  id: string;
  /**
   * The served context window, when the server reports one. vLLM sets it from
   * `--max-model-len`; oMLX and LM Studio may omit it. pi needs the real
   * number to compact in time; a window claimed larger than the server's
   * becomes a 400 several iterations into a loop, not a startup error.
   */
  contextWindow?: number;
};

/** List the models a self-hosted OpenAI-compatible server is serving. */
export async function listLocalModels(
  baseUrl: string,
  apiKey: string,
): Promise<LocalModel[]> {
  const url = `${v1Root(baseUrl)}/models`;
  const data = (await fetchJson(url, apiKey || "local", `the local endpoint at ${url}`)) as {
    data?: { id: string; max_model_len?: number; context_length?: number }[];
  };
  return (data.data ?? []).map((m) => ({
    id: m.id,
    ...(typeof m.max_model_len === "number"
      ? { contextWindow: m.max_model_len }
      : typeof m.context_length === "number"
        ? { contextWindow: m.context_length }
        : {}),
  }));
}
