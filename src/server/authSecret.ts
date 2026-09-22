/**
 * Node-only: ensure the HMAC auth secret exists on disk and in the process env.
 *
 * Reads `<DATA_DIR>/auth-secret` if present; otherwise generates 32 random
 * bytes (hex) via `node:crypto`, writes it to disk (creating the dir if
 * needed), and mirrors the value into `process.env.RADULF_AUTH_SECRET` so the
 * edge-safe session helpers in `session.ts` can read it at request time.
 *
 * Called from `src/instrumentation.ts` (the `NEXT_RUNTIME === "nodejs"` branch),
 * so the secret is available before any requests arrive.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "@/db";

export function ensureAuthSecret(): void {
  if (process.env.RADULF_AUTH_SECRET) {
    return; // already set (e.g. by a test or previous call)
  }

  // Resolved here rather than at import time: settingsCrypto imports this
  // module, and tests that mock "@/db" without DATA_DIR must still load it.
  const secretFile = join(DATA_DIR, "auth-secret");
  let secret: string;
  if (existsSync(secretFile)) {
    secret = readFileSync(secretFile, "utf-8").trim();
  } else {
    secret = randomBytes(32).toString("hex");
    mkdirSync(DATA_DIR, { recursive: true });
    // 0600 at creation: this is both the session-signing key and the root the
    // settings encryption derives from, and a stock umask would have left it
    // 0644 — readable by every other account on the host.
    writeFileSync(secretFile, secret, { encoding: "utf-8", mode: 0o600 });
  }
  // An install that predates the mode above still has a world-readable secret,
  // so tighten it in place. Never fatal: under a container that runs as a
  // different uid over the same volume the file is not ours to chmod, and it
  // is still perfectly readable.
  try {
    chmodSync(secretFile, 0o600);
  } catch {
    // not ours to tighten
  }

  process.env.RADULF_AUTH_SECRET = secret;
}