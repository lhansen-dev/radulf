import { afterEach, describe, expect, it, vi } from "vitest";
import { listProviderModels, resetProviderModelsCacheForTests } from "./providers";
import type { Settings } from "./settings";

const omlxSettings = { omlxBaseUrl: "http://127.0.0.1:8000", omlxApiKey: "key", omlxHeaders: "", omlxContextWindows: "" } as Settings;

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
  /** Settle `promise` on fake timers, so retry backoff costs no real time. */
  async function withoutBackoff<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    return promise;
  }

  it.each([
    ["a transient 503", () => Promise.resolve(jsonResponse(503, "overloaded"))],
    ["a network-level throw", () => Promise.reject(new TypeError("fetch failed"))],
  ])("retries %s and succeeds on the following 200", async (_label, firstAttempt) => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(firstAttempt)
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "m1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await withoutBackoff(listProviderModels("omlx", omlxSettings));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(models).toEqual([{ value: "m1", displayName: "m1", description: "" }]);
  });

  it("does not retry a 401, but retries a 500 twice before throwing the same error shape", async () => {
    vi.useFakeTimers();
    const unauthorized = vi.fn().mockResolvedValue(jsonResponse(401, "bad key"));
    vi.stubGlobal("fetch", unauthorized);
    await expect(withoutBackoff(listProviderModels("omlx", omlxSettings))).rejects.toThrow(/responded 401/);
    expect(unauthorized).toHaveBeenCalledTimes(1);

    const down = vi.fn().mockImplementation(async () => jsonResponse(500, "down"));
    vi.stubGlobal("fetch", down);
    await expect(withoutBackoff(listProviderModels("omlx", omlxSettings))).rejects.toThrow(/responded 500/);
    expect(down).toHaveBeenCalledTimes(3);
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

  it("re-fetches when force is set, and refreshes the cached entry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "m1" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "m1" }, { id: "m2" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await listProviderModels("omlx", omlxSettings);
    const forced = await listProviderModels("omlx", omlxSettings, { force: true });
    // The forced result replaces the cache, so the next unforced call sees it.
    const afterForce = await listProviderModels("omlx", omlxSettings);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(forced.map((m) => m.value)).toEqual(["m1", "m2"]);
    expect(afterForce).toEqual(forced);
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

  it("shows the operator's context window for a local model over the served one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, { data: [{ id: "big", max_model_len: 32_768 }, { id: "quiet" }] }))),
    );

    const models = await listProviderModels("omlx", { ...omlxSettings, omlxContextWindows: "big: 131072" } as Settings);

    expect(models).toEqual([
      { value: "big", displayName: "big", description: "131,072 ctx", contextWindow: 131_072 },
      { value: "quiet", displayName: "quiet", description: "" },
    ]);

    // Clearing the entry is a change to what is listed, so it must not hit the cache.
    const cleared = await listProviderModels("omlx", omlxSettings);
    expect(cleared[0]).toEqual({ value: "big", displayName: "big", description: "32,768 ctx", contextWindow: 32_768 });
  });
});
