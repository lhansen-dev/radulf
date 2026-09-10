import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { listAuthedModels, resetModelRuntime } = await import("./pi");

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  // getModelRuntime() mkdirs the agent dir; keep that out of the repo.
  previousDataDir = process.env.RADULF_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-pi-auth-"));
  process.env.RADULF_DATA_DIR = dataDir;
  resetModelRuntime();
  checkAuth.mockReset();
  getAvailable.mockReset();
  refresh.mockReset();
  refresh.mockResolvedValue({ aborted: false, errors: new Map() });
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.RADULF_DATA_DIR;
  else process.env.RADULF_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
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
