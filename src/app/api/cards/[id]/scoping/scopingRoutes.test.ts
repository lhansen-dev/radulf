import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scopingTurn: vi.fn(),
  proposeScopedCard: vi.fn(),
}));

vi.mock("@/server/scoping", () => ({
  scopingTurn: mocks.scopingTurn,
  proposeScopedCard: mocks.proposeScopedCard,
}));

const { POST } = await import("./route");
const { POST: PROPOSE } = await import("./proposal/route");

const ctx = { params: Promise.resolve({ id: "c1" }) };

function post(body: unknown) {
  return new Request("http://localhost/api/cards/c1/scoping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/cards/:id/scoping", () => {
  it("runs a turn and returns the thread", async () => {
    const messages = [{ id: 1, role: "user", content: "hi" }, { id: 2, role: "assistant", content: "hello" }];
    mocks.scopingTurn.mockResolvedValue(messages);

    const response = await POST(post({ content: "hi" }), ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ messages });
    expect(mocks.scopingTurn).toHaveBeenCalledWith("c1", "hi", { reply: undefined });
  });

  it("passes reply: false through for an answer that needs no reply", async () => {
    mocks.scopingTurn.mockResolvedValue([]);
    await POST(post({ content: "per account", reply: false }), ctx);
    expect(mocks.scopingTurn).toHaveBeenCalledWith("c1", "per account", { reply: false });
  });

  it("rejects a body without content, or with a non-boolean reply, before reaching the service", async () => {
    expect((await POST(post({}), ctx)).status).toBe(400);
    expect((await POST(post({ content: "x", reply: "yes" }), ctx)).status).toBe(400);
    expect(mocks.scopingTurn).not.toHaveBeenCalled();
  });
});

describe("POST /api/cards/:id/scoping/proposal", () => {
  it("returns the proposed card fields with the thread", async () => {
    const result = { title: "T", description: "D", messages: [] };
    mocks.proposeScopedCard.mockResolvedValue(result);

    const response = await PROPOSE(new Request("http://localhost/api/cards/c1/scoping/proposal", { method: "POST" }), ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(result);
    expect(mocks.proposeScopedCard).toHaveBeenCalledWith("c1");
  });
});
