import { Type } from "typebox";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * A `web_search` tool for the pi harness, backed by the Brave Search API.
 *
 * pi ships no web tool and Radulf runs the SDK with `noExtensions: true`, so
 * the community pi web-search extensions (pi-exa, pi-web-access) can't load.
 * This is the SDK-native seam instead: a custom `ToolDefinition` injected via
 * `customTools`, exactly like the scrubbed bash tool.
 *
 * Spec 14: this is the one agent-reachable network primitive L1's proxy
 * structurally cannot see (it runs in the trusted server process), so it is
 * constrained here instead:
 * - **Planner-only** among the pipeline roles — the loop and evaluator never
 *   get it bound (`createRalphSession` role tool sets). The role that reads
 *   dependency source and its own generated code holds no network primitive.
 * - **Query, not fetch** — a search string against one pinned host; no
 *   agent-supplied URL, no fetch-follow-up.
 * - **Bounded** — queries capped at 256 chars, at most 8 calls per session.
 *   Every query reaches the transcript verbatim via the normalized tool-call
 *   event, so a run that burned its budget on base64-looking strings is
 *   visible to the reviewing human.
 * - Documented residual: an injected planner can still leak ~2KB per run to
 *   one fixed, logging provider. Accepted, not solved (spec 14 §web_search).
 *
 * The key is bound at construction (never exposed to the agent's bash env). A
 * blank key does not silently disable the tool — it throws when invoked, so a
 * misconfiguration surfaces loudly rather than as a mysteriously absent tool.
 */

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
/** Per-call bandwidth bound (spec 14). */
export const MAX_QUERY_CHARS = 256;
/** Per-session call budget (spec 14). */
export const MAX_CALLS_PER_RUN = 8;

type BraveResponse = {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
};

/** Collapse whitespace and strip Brave's `<strong>` highlight markup. */
function clean(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export function createWebSearchTool(apiKey: string): ToolDefinition {
  // Per-session budget: the tool is constructed once per run's session, so a
  // closure counter is exactly the per-run cap.
  let callsUsed = 0;
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web via Brave Search. Returns a ranked list of results " +
      "(title, URL, and snippet) for a query. Use it for current information, " +
      "library/API documentation, or anything not present in the repository. " +
      "Fetch a result's page with another tool if you need its full contents.",
    promptSnippet:
      "web_search: search the live web (Brave) for information outside the repo",
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      count: Type.Optional(
        Type.Number({
          description: `How many results to return (1-${MAX_COUNT}, default ${DEFAULT_COUNT}).`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (!apiKey) {
        throw new Error(
          "web_search is unavailable: no Brave Search API key is set. Add a Brave " +
            "Search API key in Settings to enable web search.",
        );
      }
      const query = params.query?.trim();
      if (!query) throw new Error("web_search requires a non-empty query");
      if (query.length > MAX_QUERY_CHARS) {
        throw new Error(
          `web_search queries are capped at ${MAX_QUERY_CHARS} characters (got ${query.length}) — shorten the query`,
        );
      }
      if (callsUsed >= MAX_CALLS_PER_RUN) {
        throw new Error(
          `web_search budget exhausted: at most ${MAX_CALLS_PER_RUN} searches per run`,
        );
      }
      callsUsed += 1;
      const count = Math.min(
        Math.max(Math.trunc(params.count ?? DEFAULT_COUNT), 1),
        MAX_COUNT,
      );

      const url = new URL(BRAVE_ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));

      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal,
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 500);
        throw new Error(
          `Brave Search request failed: ${res.status} ${res.statusText}` +
            (body ? ` — ${body}` : ""),
        );
      }

      const data = (await res.json()) as BraveResponse;
      const results = data.web?.results ?? [];
      const text = results.length
        ? results
            .map((r, i) => {
              const title = clean(r.title ?? "") || "(untitled)";
              const desc = clean(r.description ?? "");
              return `${i + 1}. ${title}\n   ${r.url ?? ""}${desc ? `\n   ${desc}` : ""}`;
            })
            .join("\n\n")
        : `No results for "${query}".`;

      return { content: [{ type: "text", text }], details: undefined };
    },
  }) as unknown as ToolDefinition;
}
