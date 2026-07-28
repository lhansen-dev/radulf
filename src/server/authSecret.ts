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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "@/db";

const SECRET_FILE = join(DATA_DIR, "auth-secret");

export function ensureAuthSecret(): void {
  if (process.env.RADULF_AUTH_SECRET) {
    return; // already set (e.g. by a test or previous call)
  }

  let secret: string;
  if (existsSync(SECRET_FILE)) {
    secret = readFileSync(SECRET_FILE, "utf-8").trim();
  } else {
    secret = randomBytes(32).toString("hex");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SECRET_FILE, secret, "utf-8");
  }

  process.env.RADULF_AUTH_SECRET = secret;
}