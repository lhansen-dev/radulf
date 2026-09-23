/**
 * Node-only: ensure the HMAC auth secret exists on disk and in the process env.
 *
 * Reads `<DATA_DIR>/auth-secret` if present; otherwise generates 32 random
 * bytes (hex) via `node:crypto`, writes it to disk (creating the dir if
 * needed), and mirrors the value into `process.env.RADULF_AUTH_SECRET` so the
 * edge-safe session helpers in `session.ts` can read it at request time.
 *
 * Called from `src/server/boot.ts` for both the `web` and `worker` roles, so
 * the secret is available before any requests or jobs arrive. The two roles
 * may boot as separate processes at the same instant, so creation is an
 * exclusive create (`wx`) with a re-read on collision rather than an
 * exists-then-write race that would leave the two processes with different
 * secrets (spec 25 decision 8).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "@/db";

/** Trimmed file content, or "" when the file does not exist yet. */
function readSecret(file: string): string {
  try {
    return readFileSync(file, "utf-8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

/**
 * Another process won the exclusive create but may still be between creating
 * the file and writing its content; poll until the content shows up. The wait
 * is synchronous on purpose: boot is synchronous and nothing else may proceed
 * until the secret is known.
 */
function waitForSecret(file: string): string {
  const deadline = Date.now() + 5_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const secret = readSecret(file);
    if (secret) {
      return secret;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${file} exists but is empty`);
    }
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

export function ensureAuthSecret(): void {
  if (process.env.RADULF_AUTH_SECRET) {
    return; // already set (e.g. by a test or previous call)
  }

  // Resolved here rather than at import time: settingsCrypto imports this
  // module, and tests that mock "@/db" without DATA_DIR must still load it.
  const secretFile = join(DATA_DIR, "auth-secret");
  mkdirSync(DATA_DIR, { recursive: true });
  let secret = readSecret(secretFile);
  if (!secret) {
    const fresh = randomBytes(32).toString("hex");
    try {
      // 0600 at creation: this is both the session-signing key and the root the
      // settings encryption derives from, and a stock umask would have left it
      // 0644 — readable by every other account on the host. `wx` fails instead
      // of clobbering a secret a concurrent boot created a moment ago.
      writeFileSync(secretFile, fresh, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      secret = fresh;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      secret = waitForSecret(secretFile);
    }
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
