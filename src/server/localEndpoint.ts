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

/**
 * Parse the "one `Name: value` per line" header setting into a record.
 *
 * A gateway in front of a local model (Kong, a corporate proxy) often
 * authenticates on a header of its own rather than a bearer token; this is how
 * that header reaches both `/v1/models` and the pi provider block. Blank lines
 * are skipped. Anything else must be a header name (an RFC 9110 token), a
 * colon, and a non-empty value.
 */
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const m = /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m || !m[2]) throw new Error(`line ${i + 1} must look like "Name: value"`);
    headers[m[1]] = m[2];
  }
  return headers;
}

/**
 * Parse the "one `model-id: tokens` per line" context-window setting into a
 * record keyed by model id.
 *
 * Servers behind a gateway, and oMLX and LM Studio on their own, often report
 * no context length at `/v1/models`, and each served model has its own; this is
 * how an operator states them. The id is everything before the last colon, so
 * an id that itself carries one (`qwen3:8b`) parses. Blank lines are skipped.
 */
export function parseContextWindowLines(text: string): Record<string, number> {
  const windows: Record<string, number> = {};
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const m = /^\s*(.+?)\s*:\s*(\d+)\s*$/.exec(line);
    if (!m || Number(m[2]) === 0) throw new Error(`line ${i + 1} must look like "model-id: tokens"`);
    windows[m[1]] = Number(m[2]);
  }
  return windows;
}

/**
 * The context window to run `model` with: the Settings entry for it when the
 * operator wrote one, else what the server reported, else nothing (the caller
 * falls back). The setting wins because it exists for servers that report no
 * number or the wrong one.
 */
export function contextWindowFor(
  model: string,
  s: { omlxContextWindows: string },
  served?: number,
): number | undefined {
  return parseContextWindowLines(s.omlxContextWindows)[model] ?? served;
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
  headers: Record<string, string> = {},
): Promise<LocalModel[]> {
  const url = `${v1Root(baseUrl)}/models`;
  const data = (await fetchJson(url, apiKey || "local", `the local endpoint at ${url}`, headers)) as {
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
