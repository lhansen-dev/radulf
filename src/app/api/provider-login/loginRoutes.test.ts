import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listLoggableProviders: vi.fn(),
  startLogin: vi.fn(),
  readLogin: vi.fn(),
  answerLogin: vi.fn(),
  cancelLogin: vi.fn(),
  logoutProvider: vi.fn(),
}));

vi.mock("@/server/providerLogin", () => mocks);

const { GET, POST } = await import("./route");
const { GET: READ, POST: ANSWER, DELETE } = await import("./[id]/route");

const ctx = { params: Promise.resolve({ id: "s1" }) };

function post(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/provider-login", () => {
  it("lists what can be logged in to", async () => {
    const list = [{ id: "anthropic", name: "Anthropic" }];
    mocks.listLoggableProviders.mockResolvedValue(list);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(list);
  });

  it("starts a login and returns its first view", async () => {
    mocks.startLogin.mockResolvedValue({ id: "s1", status: "waiting" });

    const response = await POST(post("http://localhost/api/provider-login", {
      providerId: "anthropic",
      type: "oauth",
    }));

    expect(response.status).toBe(201);
    expect(mocks.startLogin).toHaveBeenCalledWith("anthropic", "oauth");
  });

  it("logs a provider out when the body says so", async () => {
    const response = await POST(post("http://localhost/api/provider-login", {
      providerId: "anthropic",
      logout: true,
    }));

    expect(response.status).toBe(200);
    expect(mocks.logoutProvider).toHaveBeenCalledWith("anthropic");
    expect(mocks.startLogin).not.toHaveBeenCalled();
  });

  it("rejects a missing providerId and an unknown type before reaching the service", async () => {
    expect((await POST(post("http://localhost/api/provider-login", { type: "oauth" }))).status).toBe(400);
    const bad = await POST(post("http://localhost/api/provider-login", { providerId: "a", type: "magic" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/oauth.*api_key/);
    expect(mocks.startLogin).not.toHaveBeenCalled();
  });
});

describe("/api/provider-login/:id", () => {
  it("reads the current state", async () => {
    mocks.readLogin.mockReturnValue({ id: "s1", status: "prompting" });

    const response = await READ(new Request("http://localhost/api/provider-login/s1"), ctx);

    expect(response.status).toBe(200);
    expect(mocks.readLogin).toHaveBeenCalledWith("s1");
  });

  it("answers the outstanding prompt by token", async () => {
    mocks.answerLogin.mockReturnValue({ id: "s1", status: "waiting" });

    const response = await ANSWER(
      post("http://localhost/api/provider-login/s1", { token: "t1", value: "the-code" }),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(mocks.answerLogin).toHaveBeenCalledWith("s1", "t1", "the-code");
  });

  it("insists on a token and a string value", async () => {
    expect((await ANSWER(post("http://localhost/api/provider-login/s1", { value: "x" }), ctx)).status).toBe(400);
    expect((await ANSWER(post("http://localhost/api/provider-login/s1", { token: "t1", value: 7 }), ctx)).status).toBe(400);
    expect(mocks.answerLogin).not.toHaveBeenCalled();
  });

  it("cancels a login", async () => {
    const response = await DELETE(new Request("http://localhost", { method: "DELETE" }), ctx);

    expect(response.status).toBe(200);
    expect(mocks.cancelLogin).toHaveBeenCalledWith("s1");
  });
});
