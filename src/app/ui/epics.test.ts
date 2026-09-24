import { describe, expect, it } from "vitest";
import type { BoardCard } from "./api";
import { groupEpics, waitingOn } from "./epics";

const card = (id: string, overrides: Partial<BoardCard> = {}): BoardCard =>
  ({ id, title: id, status: "backlog", position: 0, parentCardId: null, runMode: null, dependsOn: null, updatedAt: "2026-09-23T10:00:00Z", ...overrides }) as BoardCard;

describe("groupEpics", () => {
  it("groups pieces under their epic in queue order, newest epic first, and names each piece's epic", () => {
    const cards = [
      card("e1", { updatedAt: "2026-09-23T09:00:00Z" }),
      card("e2", { updatedAt: "2026-09-23T11:00:00Z" }),
      card("b", { parentCardId: "e1", position: 2 }),
      card("a", { parentCardId: "e1", position: 1 }),
      card("c", { parentCardId: "e2", position: 5 }),
      card("solo"),
      // Its epic is not in the list: a plain card, not a piece.
      card("orphan", { parentCardId: "gone" }),
    ];

    const { epics, parentOf, epicIds } = groupEpics(cards);

    expect(epics.map((group) => [group.epic.id, group.tasks.map((task) => task.id)])).toEqual([
      ["e2", ["c"]],
      ["e1", ["a", "b"]],
    ]);
    expect(parentOf.get("a")?.id).toBe("e1");
    expect(parentOf.has("orphan")).toBe(false);
    expect(parentOf.has("solo")).toBe(false);
    expect([...epicIds]).toEqual(["e1", "e2"]);
  });

  it("finds no epics among plain cards", () => {
    expect(groupEpics([card("x"), card("y")])).toEqual({ epics: [], parentOf: new Map(), epicIds: new Set() });
  });
});

describe("waitingOn", () => {
  it("names what a queued piece waits on under graph and ordered, and nothing under parallel", () => {
    const a = card("a", { status: "done", position: 1 });
    const b = card("b", { status: "looping", position: 2 });
    const c = card("c", { status: "todo", position: 3, dependsOn: ["a", "b"] });
    const d = card("d", { status: "todo", position: 4, dependsOn: null });
    const tasks = [a, b, c, d];

    expect(waitingOn(c, tasks, "graph")).toEqual([b]);
    expect(waitingOn(d, tasks, "graph")).toEqual([]);
    expect(waitingOn(c, tasks, "ordered")).toEqual([b]);
    expect(waitingOn(d, tasks, "ordered")).toEqual([b, c]);
    expect(waitingOn(c, tasks, "parallel")).toEqual([]);
    // A piece already running waits on nothing, whatever the mode.
    expect(waitingOn(b, tasks, "graph")).toEqual([]);
    expect(waitingOn(b, tasks, "ordered")).toEqual([]);
    expect(waitingOn(b, tasks, "parallel")).toEqual([]);
  });
});
