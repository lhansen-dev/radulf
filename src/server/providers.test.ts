import { afterEach, describe, expect, it, vi } from "vitest";
import { listProviderModels, resetProviderModelsCacheForTests } from "./providers";
import type { Settings } from "./settings";

const omlxSettings = { omlxBaseUrl: "http://127.0.0.1:8000", omlxApiKey: "key" } as Settings;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // Every test below shares the same omlxSettings (same cache key) but
  // expects its own fetch mock to be hit fresh — clear the module-level
  // model-list cache so one test's result can't leak into the next.
  resetProviderModelsCacheForTests();
});

describe("fetchJson retry (via listProviderModels/omlx)", () => {
  it("retries a transient 503 and succeeds on the following 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, "overloaded"))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "m1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await listProviderModels("omlx", omlxSettings);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(models).toEqual([{ value: "m1", displayName: "m1", description: "" }]);
  });

  it("does not retry a 401 — fails on the first attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(401, "bad key"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProviderModels("omlx", omlxSettings)).rejects.toThrow(/responded 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws the same error shape when every retry attempt fails", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(500, "down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProviderModels("omlx", omlxSettings)).rejects.toThrow(/responded 500/);
    // Initial attempt + 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a network-level throw and succeeds once the connection recovers", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await listProviderModels("omlx", omlxSettings);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(models).toEqual([]);
  });
});

describe("listProviderModels caching", () => {
  it("serves the second call from cache without re-fetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ id: "m1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await listProviderModels("omlx", omlxSettings);
    const second = await listProviderModels("omlx", omlxSettings);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("does not cache a failed fetch — the next call retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, "bad key"))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "m1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProviderModels("omlx", omlxSettings)).rejects.toThrow(/responded 401/);
    const second = await listProviderModels("omlx", omlxSettings);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second).toEqual([{ value: "m1", displayName: "m1", description: "" }]);
  });

  it("keys omlx cache entries by omlxBaseUrl so different endpoints don't collide", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "m1" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "m2" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const otherSettings = { ...omlxSettings, omlxBaseUrl: "http://127.0.0.1:9000" } as Settings;
    const first = await listProviderModels("omlx", omlxSettings);
    const second = await listProviderModels("omlx", otherSettings);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first).toEqual([{ value: "m1", displayName: "m1", description: "" }]);
    expect(second).toEqual([{ value: "m2", displayName: "m2", description: "" }]);
  });
});
