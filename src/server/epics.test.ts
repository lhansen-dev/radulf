import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-epics-");

const { db, cards, repos, now } = await import("@/db");
const { epicFinished, hasChildren, heldByEpicOrder, listChildren } = await import("./epics");

function seed(id: string, overrides: Partial<typeof cards.$inferInsert> = {}) {
  db.insert(cards)
    .values({ id, repoId: "r1", title: id, status: "backlog", position: 0, createdAt: now(), updatedAt: now(), ...overrides })
    .run();
}
const card = (id: string) => db.select().from(cards).where(eq(cards.id, id)).get()!;

beforeEach(() => {
  db.delete(cards).run();
  db.delete(repos).run();
  db.insert(repos).values({ id: "r1", name: "repo", path: "/tmp/r1", defaultBranch: "main", createdAt: now() }).run();
});

describe("epics", () => {
  it("lists an epic's pieces in queue order, and knows a card with none is not one", () => {
    seed("epic");
    seed("second", { parentCardId: "epic", position: 2 });
    seed("first", { parentCardId: "epic", position: 1 });
    seed("solo");

    expect(listChildren("epic").map((row) => row.id)).toEqual(["first", "second"]);
    expect(hasChildren("epic")).toBe(true);
    expect(hasChildren("solo")).toBe(false);
    expect(listChildren("solo")).toEqual([]);
  });

  it("holds an ordered epic's piece while an earlier sibling is unfinished, and nothing else", () => {
    seed("epic", { runMode: "ordered" });
    seed("a", { parentCardId: "epic", status: "done", position: 1 });
    seed("b", { parentCardId: "epic", status: "looping", position: 2 });
    seed("c", { parentCardId: "epic", status: "todo", position: 3 });
    seed("solo", { status: "todo", position: 9 });

    // b is still going, so c waits; a is done, so b was never held by it.
    expect(heldByEpicOrder(card("c"))).toBe(true);
    expect(heldByEpicOrder(card("b"))).toBe(false);
    expect(heldByEpicOrder(card("solo"))).toBe(false);

    // Abandoned counts as finished for the order, like done.
    db.update(cards).set({ status: "abandoned" }).where(eq(cards.id, "b")).run();
    expect(heldByEpicOrder(card("c"))).toBe(false);

    // A parallel epic holds nothing back.
    db.update(cards).set({ status: "looping" }).where(eq(cards.id, "b")).run();
    db.update(cards).set({ runMode: "parallel" }).where(eq(cards.id, "epic")).run();
    expect(heldByEpicOrder(card("c"))).toBe(false);
  });

  it("finishes an epic only when every piece is done or abandoned, and at least one is done", () => {
    expect(epicFinished([{ status: "done" }, { status: "abandoned" }])).toBe(true);
    expect(epicFinished([{ status: "abandoned" }])).toBe(false);
    expect(epicFinished([{ status: "done" }, { status: "review" }])).toBe(false);
    expect(epicFinished([])).toBe(false);
  });
});
