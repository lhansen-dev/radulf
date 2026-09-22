import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const checkAuth = vi.fn();
const getAvailable = vi.fn();
const refresh = vi.fn();

// Only ModelRuntime.create is faked — everything else in the SDK (tool
// definitions, defineTool) is imported for real by pi.ts and its siblings.
vi.mock("@earendil-works/pi-coding-agent", async (importActual) => {
  const actual = await importActual<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    ModelRuntime: {
      ...actual.ModelRuntime,
      create: async () => ({ checkAuth, getAvailable, refresh }),
    },
  };
});

// getModelRuntime() mkdirs the agent dir under DATA_DIR, which @/db fixes at
// import time — point it at a throwaway dir before loading pi.ts, so the dir
// stays out of the repo.
const dataDir = setupTestDataDir("radulf-pi-auth-");
const { listAuthedModels, resetModelRuntime, resolveModel } = await import("./pi");

beforeEach(() => {
  resetModelRuntime();
  checkAuth.mockReset();
  getAvailable.mockReset();
  refresh.mockReset();
  refresh.mockResolvedValue({ aborted: false, errors: new Map() });
});

afterEach(() => {
  resetModelRuntime();
});

describe("listAuthedModels — logged out vs. empty catalog", () => {
  it("throws a login error when the provider has no credential", async () => {
    // checkAuth() returns undefined for a provider with nothing in auth.json.
    checkAuth.mockResolvedValue(undefined);
    getAvailable.mockResolvedValue([]);

    await expect(listAuthedModels("chatgpt")).rejects.toThrow(/not logged in to chatgpt/);
    // The message must name the agent dir — a pi login in ~/.pi looks fine
    // from a terminal but leaves Radulf's own dir empty.
    await expect(listAuthedModels("chatgpt")).rejects.toThrow(dataDir);
    // Never even asks for the catalog: no credential, nothing to list.
    expect(getAvailable).not.toHaveBeenCalled();
  });

  it("returns an empty list (not an error) when authenticated but the catalog is empty", async () => {
    checkAuth.mockResolvedValue({ source: "OAuth", type: "oauth" });
    getAvailable.mockResolvedValue([]);

    await expect(listAuthedModels("chatgpt")).resolves.toEqual([]);
  });

  it("maps the authenticated catalog, passing pi's per-1M costs straight through", async () => {
    checkAuth.mockResolvedValue({ source: "OAuth", type: "oauth" });
    getAvailable.mockResolvedValue([
      { id: "gpt-5.5", name: "GPT-5.5", cost: { input: 1.25, output: 10 } },
      { id: "gpt-5.4-mini", name: "", cost: {} },
    ]);

    await expect(listAuthedModels("chatgpt")).resolves.toEqual([
      {
        value: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "",
        costPerMillionInput: 1.25,
        costPerMillionOutput: 10,
      },
      { value: "gpt-5.4-mini", displayName: "gpt-5.4-mini", description: "" },
    ]);
  });

  it("resyncs the provider catalog before listing, scoped to that provider", async () => {
    checkAuth.mockResolvedValue({ source: "OAuth", type: "oauth" });
    getAvailable.mockResolvedValue([]);

    await listAuthedModels("chatgpt");

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toMatchObject({
      providers: ["openai-codex"],
      allowNetwork: true,
      // Automatic listing respects the SDK's own freshness window.
      force: false,
    });
  });

  it("forces the catalog fetch when the operator asks for a reload", async () => {
    checkAuth.mockResolvedValue({ source: "OAuth", type: "oauth" });
    getAvailable.mockResolvedValue([]);

    await listAuthedModels("chatgpt", { force: true });

    expect(refresh.mock.calls[0][0]).toMatchObject({ force: true });
  });

  it("still lists models when the catalog resync fails", async () => {
    // A pi.dev outage must not empty the picker — the loaded catalog stands.
    refresh.mockRejectedValue(new Error("catalog fetch failed"));
    checkAuth.mockResolvedValue({ source: "OAuth", type: "oauth" });
    getAvailable.mockResolvedValue([{ id: "gpt-5.5", name: "GPT-5.5", cost: {} }]);

    await expect(listAuthedModels("chatgpt")).resolves.toEqual([
      { value: "gpt-5.5", displayName: "GPT-5.5", description: "" },
    ]);
  });

  it("asks pi for the provider under its own id, not Radulf's", async () => {
    checkAuth.mockResolvedValue({ source: "OAuth", type: "oauth" });
    getAvailable.mockResolvedValue([]);

    await listAuthedModels("chatgpt");
    await listAuthedModels("copilot");

    expect(checkAuth).toHaveBeenNthCalledWith(1, "openai-codex");
    expect(checkAuth).toHaveBeenNthCalledWith(2, "github-copilot");
  });
});

describe("resolveModel — OpenRouter catalog miss", () => {
  // resolveModel takes the runtime directly, so a hand-rolled fake stands in.
  function fakeRuntime(getModel: ReturnType<typeof vi.fn>) {
    return { getModel, refresh, setRuntimeApiKey: vi.fn() } as unknown as Parameters<typeof resolveModel>[0];
  }
  const settings = { openrouterApiKey: "sk-or-test" } as Parameters<typeof resolveModel>[3];

  it("resyncs the catalog and retries when the model is missing", async () => {
    // The picker offers OpenRouter's live list; a model added after this
    // runtime loaded pi's catalog must not fail the run as "unserved".
    const model = { id: "openai/gpt-6-astra" };
    const getModel = vi.fn().mockReturnValueOnce(undefined).mockReturnValueOnce(model);

    await expect(resolveModel(fakeRuntime(getModel), "openrouter", "openai/gpt-6-astra", settings)).resolves.toBe(
      model,
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toMatchObject({ providers: ["openrouter"], allowNetwork: true });
    expect(getModel).toHaveBeenCalledTimes(2);
  });

  it("skips the resync when the loaded catalog already has the model", async () => {
    const getModel = vi.fn().mockReturnValue({ id: "z-ai/glm-5.2" });

    await resolveModel(fakeRuntime(getModel), "openrouter", "z-ai/glm-5.2", settings);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-shapes an anthropic-messages catalog entry onto OpenRouter's completions API", async () => {
    // pi 0.84's OpenRouter provider sends every model through
    // openai-completions, so this entry would POST to /api/chat/completions.
    const getModel = vi.fn().mockReturnValue({
      id: "anthropic/claude-opus-5",
      api: "anthropic-messages",
      baseUrl: "https://openrouter.ai/api",
      compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: { high: "high" },
    });

    await expect(
      resolveModel(fakeRuntime(getModel), "openrouter", "anthropic/claude-opus-5", settings),
    ).resolves.toEqual({
      id: "anthropic/claude-opus-5",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      compat: { thinkingFormat: "openrouter", cacheControlFormat: "anthropic" },
      thinkingLevelMap: { high: "high" },
    });
  });

  it("leaves an openai-completions catalog entry untouched", async () => {
    const model = {
      id: "deepseek/deepseek-v4-flash",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    };
    const getModel = vi.fn().mockReturnValue(model);

    await expect(
      resolveModel(fakeRuntime(getModel), "openrouter", "deepseek/deepseek-v4-flash", settings),
    ).resolves.toBe(model);
  });

  it("still reports the model unserved when the resync doesn't find it", async () => {
    const getModel = vi.fn().mockReturnValue(undefined);

    await expect(resolveModel(fakeRuntime(getModel), "openrouter", "nope/nope", settings)).rejects.toThrow(
      'OpenRouter does not serve model "nope/nope"',
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
