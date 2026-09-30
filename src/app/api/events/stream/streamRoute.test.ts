import { describe, expect, it } from "vitest";
import type { RalphEvent } from "@/server/events";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-stream-route-");

const { bus } = await import("@/server/events");
const { GET } = await import("./route");

function event(id: number): RalphEvent {
  return {
    id,
    cardId: "card",
    runId: "run",
    type: "card.moved",
    // Big enough that a thousand of them pass the buffer bound.
    payload: JSON.stringify({ filler: "x".repeat(4_000) }),
    createdAt: "2026-09-22T00:00:00.000Z",
  };
}

describe("GET /api/events/stream", () => {
  it("streams events to a reader", async () => {
    const response = await GET(new Request("http://localhost/api/events/stream"));
    const reader = response.body!.getReader();
    const decode = new TextDecoder();

    expect(decode.decode((await reader.read()).value)).toBe(": connected\n\n");
    bus.emit("event", event(1));
    expect(decode.decode((await reader.read()).value)).toContain('"id":1');

    await reader.cancel();
  });

  it("drops a client that stopped reading instead of buffering for it", async () => {
    // A suspended tab: the response body is never read, so every frame stays
    // queued in this process. Unbounded, one such tab grows until the
    // orchestrator's own process dies.
    const response = await GET(new Request("http://localhost/api/events/stream"));
    const reader = response.body!.getReader();

    for (let i = 0; i < 1_000; i++) bus.emit("event", event(i));

    expect(bus.listenerCount("event")).toBe(0);
    // Everything queued before the bound was hit is still readable, and the
    // stream is closed rather than live — EventSource reconnects, and the
    // client refetches on reconnect.
    let done = false;
    while (!done) done = (await reader.read()).done;
  });
});
