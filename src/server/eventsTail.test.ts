import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-events-tail-");

const { db, events } = await import("@/db");
const { bus, emitEvent } = await import("./events");
const { latestEventId, tailEventsOnce } = await import("./eventsTail");

function insertForeign() {
  return db
    .insert(events)
    .values({ type: "foreign.test", payload: "{}", createdAt: new Date().toISOString() })
    .returning()
    .get();
}

function countEvents(): number {
  return db.select().from(events).all().length;
}

describe("eventsTail", () => {
  const spy = vi.fn();

  beforeEach(() => {
    db.delete(events).run();
    spy.mockReset();
    bus.on("event", spy);
  });

  afterEach(() => {
    bus.off("event", spy);
  });

  it("emits a row inserted by another process exactly once", () => {
    const state = { lastId: latestEventId() };
    const foreign = insertForeign();

    const emitted = tailEventsOnce(state);

    expect(emitted.map((e) => e.id)).toEqual([foreign.id]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].id).toBe(foreign.id);
    expect(spy.mock.calls[0][0].type).toBe("foreign.test");

    // A second tick emits nothing new.
    expect(tailEventsOnce(state)).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not re-emit an event this process emitted locally", () => {
    const state = { lastId: latestEventId() };
    const local = emitEvent("local.test");
    expect(spy).toHaveBeenCalledTimes(1);

    const emitted = tailEventsOnce(state);

    expect(emitted).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].id).toBe(local.id);
    expect(state.lastId).toBe(local.id);
  });

  it("delivers a mix of local and foreign events exactly once each", () => {
    const state = { lastId: latestEventId() };
    const local = emitEvent("local.test");
    const foreign = insertForeign();

    tailEventsOnce(state);

    const seenIds = spy.mock.calls.map((c) => c[0].id);
    expect(seenIds.filter((id) => id === local.id)).toHaveLength(1);
    expect(seenIds.filter((id) => id === foreign.id)).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(state.lastId).toBe(Math.max(local.id, foreign.id));
  });

  it("never emits rows that existed before latestEventId() was taken", () => {
    insertForeign();
    insertForeign();
    const state = { lastId: latestEventId() };

    const emitted = tailEventsOnce(state);

    expect(emitted).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("writes nothing to the events table", () => {
    const state = { lastId: latestEventId() };
    insertForeign();
    emitEvent("local.test");
    const before = countEvents();

    tailEventsOnce(state);
    tailEventsOnce(state);

    expect(countEvents()).toBe(before);
  });
});
