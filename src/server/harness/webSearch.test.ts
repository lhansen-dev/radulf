import { describe, it, expect, vi, afterEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWebSearchTool, MAX_QUERY_CHARS, MAX_CALLS_PER_RUN } from "./webSearch";

/** The execute contract needs a ctx; the Brave tool never touches it. */
const CTX = {} as ExtensionContext;

function run(tool: ReturnType<typeof createWebSearchTool>, query: string, count?: number) {
  return tool.execute("call-1", { query, count }, undefined, undefined, CTX);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createWebSearchTool", () => {
  it("throws — not silently disables — when no key is configured", async () => {
    const tool = createWebSearchTool("");
    await expect(run(tool, "anything")).rejects.toThrow(/no Brave Search API key/i);
  });

  it("sends the key + clamped count and formats results, stripping highlight markup", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "Pi <strong>agent</strong>", url: "https://pi.dev", description: "a  minimal   harness" },
              { title: "", url: "https://example.com", description: "" },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const tool = createWebSearchTool("secret-key");
    const result = await run(tool, "  pi agent  ", 999);

    const url = new URL((fetchSpy.mock.calls[0][0] as URL).toString());
    expect(url.searchParams.get("q")).toBe("pi agent"); // trimmed
    expect(url.searchParams.get("count")).toBe("20"); // clamped to MAX
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get("X-Subscription-Token")).toBe("secret-key");

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("1. Pi agent"); // <strong> stripped, whitespace collapsed
    expect(text).toContain("https://pi.dev");
    expect(text).toContain("a minimal harness");
    expect(text).toContain("2. (untitled)"); // empty title placeholder
  });

  it("throws with the status when Brave returns an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    );
    const tool = createWebSearchTool("key");
    await expect(run(tool, "x")).rejects.toThrow(/429/);
  });

  it("reports no results plainly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
    );
    const tool = createWebSearchTool("key");
    const result = await run(tool, "obscure query");
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toMatch(/No results for "obscure query"/);
  });

  // Spec 14 Phase 2b bandwidth bounds — the accepted-residual mitigation.
  it("rejects blank and over-cap queries before hitting the network, without spending budget", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
    );
    const tool = createWebSearchTool("key");
    await expect(run(tool, "   ")).rejects.toThrow(/non-empty query/i);
    await expect(run(tool, "a".repeat(MAX_QUERY_CHARS + 1))).rejects.toThrow(
      new RegExp(`capped at ${MAX_QUERY_CHARS} characters`),
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    // Rejections spent nothing: the full budget remains, including a query at exactly the cap.
    await run(tool, "a".repeat(MAX_QUERY_CHARS));
    for (let i = 1; i < MAX_CALLS_PER_RUN; i++) await run(tool, `query ${i}`);
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_CALLS_PER_RUN);

    await expect(run(tool, "one too many")).rejects.toThrow(/budget exhausted/i);
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_CALLS_PER_RUN);
  });
});
