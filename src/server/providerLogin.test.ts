import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

/** Stand-in for the one pi API this module drives. */
type Interaction = {
  signal?: AbortSignal;
  notify: (event: Record<string, unknown>) => void;
  prompt: (p: Record<string, unknown>) => Promise<string>;
};

const mocks = vi.hoisted(() => ({
  providers: [] as unknown[],
  checkAuth: vi.fn(),
  logout: vi.fn(),
  /** Set per test: what pi does once login starts. */
  flow: (() => Promise.resolve({})) as (i: Interaction) => Promise<unknown>,
}));

vi.mock("./harness", () => ({
  getModelRuntime: async () => ({
    getProviders: () => mocks.providers,
    checkAuth: mocks.checkAuth,
    logout: mocks.logout,
    login: (_id: string, _type: string, interaction: Interaction) => mocks.flow(interaction),
  }),
}));

setupTestDataDir("radulf-provider-login-");

const { db, events } = await import("@/db");
const {
  answerLogin,
  cancelLogin,
  listLoggableProviders,
  logoutProvider,
  readLogin,
  resetLoginsForTests,
  startLogin,
} = await import("./providerLogin");

/** Wait for the module's own promise chain to settle. */
const settle = () => new Promise((r) => setImmediate(r));

const ANTHROPIC = {
  id: "anthropic",
  name: "Anthropic",
  auth: {
    oauth: { name: "Anthropic (Claude Pro/Max)", isSubscription: true },
    apiKey: { name: "Anthropic API key", login: () => {} },
  },
};
const AMBIENT = { id: "ambient", name: "Ambient only", auth: { apiKey: { name: "no login" } } };

beforeEach(() => {
  db.delete(events).run();
  mocks.providers = [ANTHROPIC, AMBIENT];
  mocks.checkAuth.mockReset().mockResolvedValue(undefined);
  mocks.logout.mockReset().mockResolvedValue(undefined);
  mocks.flow = () => new Promise(() => {}); // hangs until a test says otherwise
});

afterEach(() => {
  resetLoginsForTests();
});

const eventTypes = () => db.select().from(events).all().map((row) => row.type);

describe("listLoggableProviders", () => {
  it("lists only what can actually be logged in to, with its status", async () => {
    mocks.checkAuth.mockImplementation(async (id: string) =>
      id === "anthropic" ? { type: "oauth", source: "OAuth" } : undefined,
    );

    const list = await listLoggableProviders();

    // "Ambient only" has an apiKey method with no interactive login, so there
    // is nothing to offer for it.
    expect(list.map((p) => p.id)).toEqual(["anthropic"]);
    expect(list[0]).toMatchObject({
      name: "Anthropic",
      oauth: { name: "Anthropic (Claude Pro/Max)", subscription: true, label: null },
      apiKey: { name: "Anthropic API key" },
      connected: { type: "oauth", source: "OAuth" },
    });
  });

  it("reports a provider whose check throws as not connected, without losing the rest", async () => {
    mocks.providers = [ANTHROPIC, { ...ANTHROPIC, id: "other", name: "Other" }];
    mocks.checkAuth.mockImplementation(async (id: string) => {
      if (id === "anthropic") throw new Error("credential store unreadable");
      return { type: "oauth", source: "OAuth" };
    });

    const list = await listLoggableProviders();

    expect(list).toHaveLength(2);
    expect(list.find((p) => p.id === "anthropic")!.connected).toBeNull();
    expect(list.find((p) => p.id === "other")!.connected).toMatchObject({ type: "oauth" });
  });
});

describe("startLogin", () => {
  it("refuses a provider it does not have, and a method that provider lacks", async () => {
    await expect(startLogin("nope", "oauth")).rejects.toThrow(/no such provider/);
    await expect(startLogin("ambient", "api_key")).rejects.toThrow(/has no api_key login/);
  });

  it("refuses a second login to the same provider", async () => {
    await startLogin("anthropic", "oauth");
    await expect(startLogin("anthropic", "oauth")).rejects.toThrow(/already in progress/);
  });

  it("carries pi's events through, and parks its prompt for an answer", async () => {
    let answered: string | undefined;
    mocks.flow = async (interaction) => {
      interaction.notify({ type: "auth_url", url: "https://example.test/auth?state=abc", instructions: "open it" });
      answered = await interaction.prompt({ type: "manual_code", message: "paste the code", placeholder: "http://localhost" });
      interaction.notify({ type: "progress", message: "Exchanging…" });
      return { type: "oauth" };
    };

    const started = await startLogin("anthropic", "oauth");
    await settle();

    const waiting = readLogin(started.id);
    expect(waiting.status).toBe("prompting");
    expect(waiting.events[0]).toMatchObject({ type: "auth_url", url: "https://example.test/auth?state=abc" });
    expect(waiting.prompt).toMatchObject({ kind: "manual_code", message: "paste the code", placeholder: "http://localhost" });

    answerLogin(started.id, waiting.prompt!.token, "the-code");
    await settle();

    expect(answered).toBe("the-code");
    expect(readLogin(started.id).status).toBe("done");
    // The audit trail says a provider was connected and nothing else: no
    // answer, and no auth_url, which carries the PKCE state.
    expect(eventTypes()).toContain("provider.login");
    const payload = JSON.parse(db.select().from(events).all().at(-1)!.payload);
    expect(payload).toEqual({ providerId: "anthropic", type: "oauth" });
  });

  it("passes a select prompt's options through for rendering", async () => {
    mocks.flow = async (interaction) => {
      await interaction.prompt({
        type: "select",
        message: "How do you want to sign in?",
        options: [{ id: "oauth", label: "Use a subscription" }, { id: "key", label: "Use an API key" }],
      });
      return {};
    };

    const started = await startLogin("anthropic", "oauth");
    await settle();

    expect(readLogin(started.id).prompt).toMatchObject({
      kind: "select",
      options: [{ id: "oauth", label: "Use a subscription" }, { id: "key", label: "Use an API key" }],
    });
  });

  it("records why a login failed, and keeps the reason readable", async () => {
    mocks.flow = async () => {
      throw new Error("OAuth state mismatch");
    };

    const started = await startLogin("anthropic", "oauth");
    await settle();

    expect(readLogin(started.id)).toMatchObject({ status: "failed", error: "OAuth state mismatch" });
    expect(eventTypes()).not.toContain("provider.login");
  });

  it("frees the provider once a login has settled", async () => {
    mocks.flow = async () => {
      throw new Error("nope");
    };
    const first = await startLogin("anthropic", "oauth");
    await settle();
    expect(readLogin(first.id).status).toBe("failed");

    await expect(startLogin("anthropic", "oauth")).resolves.toMatchObject({ status: "waiting" });
  });
});

describe("answerLogin", () => {
  it("refuses an answer to a question the flow has moved past", async () => {
    mocks.flow = async (interaction) => {
      await interaction.prompt({ type: "text", message: "first" });
      await interaction.prompt({ type: "text", message: "second" });
      return {};
    };
    const started = await startLogin("anthropic", "oauth");
    await settle();
    const first = readLogin(started.id).prompt!;

    answerLogin(started.id, first.token, "a");
    await settle();

    const second = readLogin(started.id).prompt!;
    expect(second.message).toBe("second");
    // Each prompt gets its own token, so a late answer cannot resolve the
    // question that replaced the one it was for.
    expect(second.token).not.toBe(first.token);
    expect(() => answerLogin(started.id, first.token, "late")).toThrow(/moved past/);
  });

  it("refuses an answer when nothing is being asked, and 404s an unknown login", async () => {
    const started = await startLogin("anthropic", "oauth");
    expect(() => answerLogin(started.id, "any", "x")).toThrow(/not waiting on an answer/);
    expect(() => answerLogin("nope", "any", "x")).toThrow(/not found/);
    expect(() => readLogin("nope")).toThrow(/not found/);
  });

  it("takes a withdrawn prompt back off the screen", async () => {
    // What a host install does: the loopback callback wins the race and pi
    // aborts the paste box it was offering.
    const withdraw = new AbortController();
    mocks.flow = async (interaction) => {
      await interaction
        .prompt({ type: "manual_code", message: "paste it", signal: withdraw.signal })
        .catch(() => {});
      return {};
    };
    const started = await startLogin("anthropic", "oauth");
    await settle();
    expect(readLogin(started.id).prompt).not.toBeNull();

    withdraw.abort();
    await settle();

    expect(readLogin(started.id).prompt).toBeNull();
  });
});

describe("cancelLogin", () => {
  it("aborts the flow and forgets the session", async () => {
    let aborted = false;
    mocks.flow = (interaction) =>
      new Promise((_resolve, reject) => {
        interaction.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("cancelled"));
        });
      });
    const started = await startLogin("anthropic", "oauth");

    cancelLogin(started.id);
    await settle();

    expect(aborted).toBe(true);
    expect(() => readLogin(started.id)).toThrow(/not found/);
    // And the provider is free again straight away.
    await expect(startLogin("anthropic", "oauth")).resolves.toMatchObject({ status: "waiting" });
  });
});

describe("logoutProvider", () => {
  it("forgets the credential and records it", async () => {
    await logoutProvider("anthropic");

    expect(mocks.logout).toHaveBeenCalledWith("anthropic");
    expect(eventTypes()).toContain("provider.logout");
  });

  it("404s a provider it does not have", async () => {
    await expect(logoutProvider("nope")).rejects.toThrow(/no such provider/);
    expect(mocks.logout).not.toHaveBeenCalled();
  });
});
