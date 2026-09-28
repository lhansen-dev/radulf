import { afterEach, describe, expect, it, vi } from "vitest";
import { contextWindowFor, listLocalModels, parseContextWindowLines, parseHeaderLines, v1Root } from "./localEndpoint";

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

describe("parseHeaderLines", () => {
  it("reads one Name: value per line, trimming and skipping blank lines", () => {
    expect(parseHeaderLines("kong-api-key: abc123\n\n  X-Tenant :  lab  \n")).toEqual({
      "kong-api-key": "abc123",
      "X-Tenant": "lab",
    });
    expect(parseHeaderLines("")).toEqual({});
  });

  it("keeps a colon inside the value, since tokens and URLs carry them", () => {
    expect(parseHeaderLines("Authorization: Bearer a:b")).toEqual({ Authorization: "Bearer a:b" });
  });

  it.each(["no-colon", "kong api key: v", ": v", "name:"])(
    "rejects %j and names the line",
    (line) => {
      expect(() => parseHeaderLines(`ok: yes\n${line}`)).toThrow('line 2 must look like "Name: value"');
    },
  );
});

describe("parseContextWindowLines", () => {
  it("reads one model-id: tokens per line, trimming and skipping blank lines", () => {
    expect(parseContextWindowLines("Qwen/Qwen3-8B: 131072\n\n  gemma-3 :  32768  \n")).toEqual({
      "Qwen/Qwen3-8B": 131_072,
      "gemma-3": 32_768,
    });
    expect(parseContextWindowLines("")).toEqual({});
  });

  it("splits at the last colon, since a model id can carry one", () => {
    expect(parseContextWindowLines("qwen3:8b: 65536")).toEqual({ "qwen3:8b": 65_536 });
  });

  it.each(["no-colon", "model: 128k", "model: -1", "model: 0", ": 4096", "model:"])(
    "rejects %j and names the line",
    (line) => {
      expect(() => parseContextWindowLines(`ok: 4096\n${line}`)).toThrow('line 2 must look like "model-id: tokens"');
    },
  );
});

describe("contextWindowFor", () => {
  it("prefers the operator's entry, then the served number, then nothing", () => {
    const s = { omlxContextWindows: "big: 131072" };
    expect(contextWindowFor("big", s, 32_768)).toBe(131_072);
    expect(contextWindowFor("other", s, 32_768)).toBe(32_768);
    expect(contextWindowFor("other", s)).toBeUndefined();
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

  it("sends extra headers alongside the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listLocalModels("http://localhost:8000", "key", { "kong-api-key": "abc123" });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      Authorization: "Bearer key",
      "kong-api-key": "abc123",
    });
  });

  it("lets an Authorization header replace the bearer token instead of doubling it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listLocalModels("http://localhost:8000", "", { authorization: "Basic xyz" });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ authorization: "Basic xyz" });
  });

  it("names the URL it could not reach, so a wrong base URL is obvious", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(listLocalModels("http://localhost:9999", "")).rejects.toThrow(
      "cannot reach the local endpoint at http://localhost:9999/v1/models",
    );
  });
});
