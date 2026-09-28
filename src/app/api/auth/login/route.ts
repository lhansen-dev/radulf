import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  signSession,
  redirectBase,
  requestIsSecure,
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
} from "@/server/session";
import {
  BASE_FAILURE_DELAY_MS,
  clearLoginFailures,
  isLoginRateLimited,
  loginClientKey,
  loginFailureDelayMs,
  recordLoginFailure,
  usesSharedLoginBucket,
} from "@/server/loginRateLimit";
import { err } from "../../_lib";

/**
 * Password checks in flight. A bcrypt compare at the documented cost of 12
 * is a few hundred milliseconds of CPU, and this is the one process that
 * also runs the orchestrator, its watchdogs and the SSE stream. The compare
 * runs async so it yields between rounds instead of blocking the event loop
 * for its whole duration, but a flood of concurrent checks is still a flood
 * of CPU: past this many at once, answer 503 without checking. The cap sits
 * well above what a human retrying a password produces, and a flood that
 * reaches it has already made the instance unusable by other means.
 */
const MAX_CONCURRENT_PASSWORD_CHECKS = 8;
const MAX_LOGIN_BODY_BYTES = 16 * 1024;
const MAX_PASSWORD_BYTES = 4 * 1024;
let passwordChecksInFlight = 0;

async function readLimitedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_LOGIN_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The size decision is already final even if the client vanished.
      }
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// ── Route ─────────────────────────────────────────────────────

export async function POST(request: Request) {
  const clientKey = loginClientKey(request);

  // Refuse known oversized bodies before parsing or scheduling bcrypt work.
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_LOGIN_BODY_BYTES) {
    return err("Request body too large", 413);
  }

  // Hard cutoff only when clients are individually identifiable. In the shared
  // bucket a 429 would let anyone who can reach the port lock the operator out,
  // so that mode escalates delay below instead of refusing.
  const shared = usesSharedLoginBucket();
  if (!shared && isLoginRateLimited(clientKey)) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429 },
    );
  }

  if (passwordChecksInFlight >= MAX_CONCURRENT_PASSWORD_CHECKS) {
    return NextResponse.json(
      { error: "Too many login attempts in progress. Try again shortly." },
      { status: 503 },
    );
  }
  passwordChecksInFlight++;

  let valid = false;
  try {
    let bodyBytes: Uint8Array | null;
    try {
      bodyBytes = await readLimitedBody(request);
    } catch {
      return err("Invalid request body", 400);
    }
    if (!bodyBytes) return err("Request body too large", 413);

    const bodyText = new TextDecoder().decode(bodyBytes);
    const ct = request.headers.get("content-type") ?? "";
    let password = "";
    try {
      if (ct.includes("json")) {
        const body: unknown = JSON.parse(bodyText);
        if (typeof body !== "object" || body === null || !("password" in body)) {
          return err("Invalid request body", 400);
        }
        password = String(body.password ?? "");
      } else {
        password = new URLSearchParams(bodyText).get("password") ?? "";
      }
    } catch {
      return err("Invalid request body", 400);
    }
    if (new TextEncoder().encode(password).byteLength > MAX_PASSWORD_BYTES) {
      return err("Password too large", 413);
    }
    const hash = process.env.RADULF_AUTH_PASSWORD_HASH;
    valid = !!hash && (await bcrypt.compare(password, hash));
  } finally {
    passwordChecksInFlight--;
  }
  if (!valid) {
    recordLoginFailure(clientKey);
    // Stall before answering: a flat baseline for identified clients (which
    // also have the cutoff above), escalating for the shared bucket.
    await new Promise((r) =>
      setTimeout(r, shared ? loginFailureDelayMs(clientKey) : BASE_FAILURE_DELAY_MS),
    );
    return err("Invalid password", 401);
  }

  // Success — issue a session cookie
  clearLoginFailures(clientKey);
  const expiresAtMs = Date.now() + SESSION_MAX_AGE_MS;
  const value = await signSession(expiresAtMs);

  const response = NextResponse.redirect(new URL("/", redirectBase(request)));
  response.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: requestIsSecure(request),
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1_000),
    expires: new Date(expiresAtMs),
  });

  return response;
}
