/**
 * Node-only: the session revocation epoch, the kill switch for a leaked
 * session cookie.
 *
 * A cookie is an HMAC over its expiry and this epoch (session.ts), so moving
 * the epoch invalidates every cookie issued so far without touching
 * `data/auth-secret`, which the settings encryption derives its key from too.
 * The value lives in three places, one per reader: `<DATA_DIR>/session-epoch`
 * so it survives a restart; `process.env.RADULF_SESSION_EPOCH` so the proxy
 * verifies with no file read per request, the same way it reads the secret;
 * and an `events` row so every web replica (spec 25) adopts it, not only the
 * process that handled the logout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "@/db";
import { bus, emitEvent, type RalphEvent } from "./events";

export const SESSIONS_REVOKED_EVENT = "auth.sessions_revoked";

function currentEpoch(): number {
  return Number(process.env.RADULF_SESSION_EPOCH ?? 0);
}

/** Never move backwards: two replicas revoking at once deliver each other's
 * event, and the later epoch must win on both. */
function adopt(epoch: string): void {
  if (Number(epoch) > currentEpoch()) process.env.RADULF_SESSION_EPOCH = epoch;
}

/** Boot, web role: read the stored epoch, then follow revocations other
 * processes make from here on. */
export function trackSessionEpoch(): void {
  try {
    adopt(readFileSync(join(DATA_DIR, "session-epoch"), "utf-8").trim());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  bus.on("event", (row: RalphEvent) => {
    if (row.type !== SESSIONS_REVOKED_EVENT) return;
    const { epoch } = JSON.parse(row.payload) as { epoch?: unknown };
    if (typeof epoch === "string") adopt(epoch);
  });
}

/** Invalidate every session issued so far: here, on disk, and in every other
 * web process. */
export function revokeAllSessions(): void {
  // Strictly past the epoch in force, so a revocation always lands even when
  // the clock is behind the last one.
  const epoch = String(Math.max(Date.now(), currentEpoch() + 1));
  writeFileSync(join(DATA_DIR, "session-epoch"), epoch, "utf-8");
  adopt(epoch);
  emitEvent(SESSIONS_REVOKED_EVENT, { payload: { epoch } });
}
