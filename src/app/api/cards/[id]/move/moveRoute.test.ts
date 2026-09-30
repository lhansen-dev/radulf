import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const mocks = vi.hoisted(() => ({
  startCard: vi.fn(),
  queueCard: vi.fn(),
  cancelCard: vi.fn(),
}));

vi.mock("@/server/orchestrator", () => ({
  getOrchestrator: () => ({
    startCard: mocks.startCard,
    queueCard: mocks.queueCard,
    cancelCard: mocks.cancelCard,
  }),
}));

setupTestDataDir("radulf-move-route-");

const { db, cards, repos, now } = await import("@/db");
const { POST } = await import("./route");

/** Raw JSON text, not an object: `JSON.stringify` cannot express Infinity —
 * it writes `null`, which the old `typeof` check already rejected, so a test
 * built that way passes without exercising this at all. `1e999` is valid JSON
 * that `JSON.parse` overflows to Infinity, which is how a real request gets
 * one past the wire. (NaN has no JSON literal and is unreachable this way.) */
function post(id: string, body: string) {
  return POST(
    new Request(`http://localhost/api/cards/${id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    { params: Promise.resolve({ id }) },
  );
}

function getCard(id: string) {
  return db.select().from(cards).where(eq(cards.id, id)).get()!;
}

beforeEach(() => {
  db.delete(cards).run();
  db.delete(repos).run();
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo", path: "/tmp/radulf-move-route-repo", defaultBranch: "main", createdAt: now() })
    .run();
  db.insert(cards)
    .values({
      id: "todo-card",
      repoId: "repo-1",
      title: "Card",
      description: "",
      status: "todo",
      position: 1,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  vi.clearAllMocks();
});

describe("POST /api/cards/[id]/move", () => {
  // better-sqlite3 stores Infinity in a REAL column without complaint, and
  // queueCard then reads max(position) + 1 — which is Infinity again — for
  // every card queued afterwards, so one bad request permanently flattens the
  // ordering pump() relies on to keep the todo queue FIFO.
  it("rejects a position that overflows to Infinity instead of persisting it", async () => {
    const response = await post("todo-card", '{"to":"todo","position":1e999}');

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/finite/);
    expect(getCard("todo-card").position).toBe(1);
  });

  it("rejects -Infinity, which would otherwise jump the queue", async () => {
    const response = await post("todo-card", '{"to":"todo","position":-1e999}');

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/finite/);
    expect(getCard("todo-card").position).toBe(1);
  });

  it("still accepts an ordinary finite reorder position", async () => {
    const response = await post("todo-card", '{"to":"todo","position":7}');

    expect(response.status).toBe(200);
    expect(getCard("todo-card").position).toBe(7);
  });
});
