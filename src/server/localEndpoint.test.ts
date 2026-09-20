import { afterEach, describe, expect, it, vi } from "vitest";
import { listLocalModels, v1Root } from "./localEndpoint";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("v1Root", () => {
  it("appends /v1 to a server root", () => {
    expect(v1Root("http://localhost:8000")).toBe("http://localhost:8000/v1");
  });

  it("accepts a base URL that already carries /v1, with or without a trailing slash", () => {
    expect(v1Root("https://vllm.example.com/v1")).toBe("https://vllm.example.com/v1");
    expect(v1Root("https://vllm.example.com/v1/")).toBe("https://vllm.example.com/v1");
    expect(v1Root("https://vllm.example.com/")).toBe("https://vllm.example.com/v1");
  });

  it("ignores surrounding whitespace, which a pasted URL carries", () => {
    expect(v1Root("  http://localhost:8000  ")).toBe("http://localhost:8000/v1");
  });
});

describe("listLocalModels", () => {
  it("lists ids from /v1/models under the configured base URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "a" }, { id: "b" }] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await listLocalModels("http://localhost:8000", "")).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8000/v1/models");
  });

  it("reads the served context window from vLLM's max_model_len", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse(200, { data: [{ id: "llm", max_model_len: 65_536 }] }),
      ),
    );

    expect(await listLocalModels("http://localhost:8000", "")).toEqual([
      { id: "llm", contextWindow: 65_536 },
    ]);
  });

  it("falls back to context_length, and omits the window when neither is reported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse(200, {
          data: [{ id: "a", context_length: 8_192 }, { id: "b" }],
        }),
      ),
    );

    expect(await listLocalModels("http://localhost:8000", "")).toEqual([
      { id: "a", contextWindow: 8_192 },
      { id: "b" },
    ]);
  });

  it("names the URL it could not reach, so a wrong base URL is obvious", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(listLocalModels("http://localhost:9999", "")).rejects.toThrow(
      "cannot reach the local endpoint at http://localhost:9999/v1/models",
    );
  });
});
