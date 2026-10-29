import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const dataDir = setupTestDataDir("radulf-session-epoch-");
process.env.RADULF_AUTH_SECRET =
  "4e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f";

const { db, events } = await import("@/db");
const { bus } = await import("./events");
const { SESSION_MAX_AGE_MS, signSession, verifySession } = await import("./session");
const { SESSIONS_REVOKED_EVENT, revokeAllSessions, trackSessionEpoch } = await import("./sessionEpoch");

const epochFile = path.join(dataDir, "session-epoch");

afterEach(() => {
  delete process.env.RADULF_SESSION_EPOCH;
  fs.rmSync(epochFile, { force: true });
});

describe("revokeAllSessions", () => {
  it("invalidates every cookie issued before it, and none issued after", async () => {
    const before = await signSession(Date.now() + SESSION_MAX_AGE_MS);
    expect(await verifySession(before)).toBe(true);

    revokeAllSessions();

    expect(await verifySession(before)).toBe(false);
    expect(await verifySession(await signSession(Date.now() + SESSION_MAX_AGE_MS))).toBe(true);
  });

  it("persists the epoch for the next boot and announces it to other processes", () => {
    revokeAllSessions();
    const epoch = process.env.RADULF_SESSION_EPOCH!;

    expect(fs.readFileSync(epochFile, "utf-8")).toBe(epoch);
    const announced = db.select().from(events).all().filter((row) => row.type === SESSIONS_REVOKED_EVENT);
    expect(announced.map((row) => JSON.parse(row.payload))).toContainEqual({ epoch });

    // A fresh process has no epoch in its env and reads the file.
    delete process.env.RADULF_SESSION_EPOCH;
    trackSessionEpoch();
    expect(process.env.RADULF_SESSION_EPOCH).toBe(epoch);
  });

  it("always moves forward, even when the clock is behind the epoch in force", () => {
    process.env.RADULF_SESSION_EPOCH = String(Date.now() + 60_000);
    const inForce = process.env.RADULF_SESSION_EPOCH;

    revokeAllSessions();

    expect(Number(process.env.RADULF_SESSION_EPOCH)).toBeGreaterThan(Number(inForce));
  });
});

describe("trackSessionEpoch", () => {
  it("adopts a revocation another process announced, and never moves backwards", () => {
    trackSessionEpoch();
    const announce = (epoch: string) =>
      bus.emit("event", {
        id: 0,
        cardId: null,
        runId: null,
        type: SESSIONS_REVOKED_EVENT,
        payload: JSON.stringify({ epoch }),
        createdAt: "",
      });

    announce("2000");
    expect(process.env.RADULF_SESSION_EPOCH).toBe("2000");
    announce("1000");
    expect(process.env.RADULF_SESSION_EPOCH).toBe("2000");
  });
});
