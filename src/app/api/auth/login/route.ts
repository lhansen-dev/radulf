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
const LOGIN_BODY_TIMEOUT_MS = 5_000;
let passwordChecksInFlight = 0;

const BODY_READ_TIMED_OUT = Symbol("body read timed out");

async function readLimitedBody(
  request: Request,
): Promise<Uint8Array | null | typeof BODY_READ_TIMED_OUT> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, LOGIN_BODY_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) return BODY_READ_TIMED_OUT;
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
  } finally {
    clearTimeout(timer);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Why a login was refused, as the login page's `?error=` reason. A browser
 * form post is sent back there (303, so the browser GETs the page) because
 * a JSON body in place of the page is a dead end with no way to retry. An
 * API client, which sent JSON, gets the status and JSON it can act on.
 */
type RefusalReason = "invalid" | "rate-limited" | "busy";

function refuse(request: Request, formPost: boolean, message: string, status: number, reason: RefusalReason) {
  if (!formPost) return NextResponse.json({ error: message }, { status });
  const url = new URL("/login", redirectBase(request));
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url, 303);
}

// ── Route ─────────────────────────────────────────────────────

export async function POST(request: Request) {
  const clientKey = loginClientKey(request);
  const ct = request.headers.get("content-type") ?? "";
  const formPost = !ct.includes("json");

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
    return refuse(request, formPost, "Too many attempts. Try again later.", 429, "rate-limited");
  }

  let bodyBytes: Uint8Array | null | typeof BODY_READ_TIMED_OUT;
  try {
    bodyBytes = await readLimitedBody(request);
  } catch {
    return err("Invalid request body", 400);
  }
  if (bodyBytes === BODY_READ_TIMED_OUT) return err("Request body timed out", 408);
  if (!bodyBytes) return err("Request body too large", 413);

  const bodyText = new TextDecoder().decode(bodyBytes);
  let password = "";
  try {
    if (!formPost) {
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

  // Reading a bounded body can still take several seconds. Recheck here so a
  // client that crossed the failure threshold meanwhile cannot enter bcrypt.
  if (!shared && isLoginRateLimited(clientKey)) {
    return refuse(request, formPost, "Too many attempts. Try again later.", 429, "rate-limited");
  }

  if (passwordChecksInFlight >= MAX_CONCURRENT_PASSWORD_CHECKS) {
    return refuse(request, formPost, "Too many login attempts in progress. Try again shortly.", 503, "busy");
  }
  passwordChecksInFlight++;

  let valid = false;
  let released = false;
  try {
    const hash = process.env.RADULF_AUTH_PASSWORD_HASH;
    valid = !!hash && (await bcrypt.compare(password, hash));
    if (!valid) {
      recordLoginFailure(clientKey);
      // Keep the admission slot through the flat baseline delay only, so a
      // flood is throttled to one compare per slot per second. The shared
      // bucket's escalation runs after the slot is released: holding a slot
      // for up to 15s would let eight bad guesses in flight fill every slot
      // and 503 the operator — the lockout the shared bucket exists to avoid.
      const escalationMs = shared ? loginFailureDelayMs(clientKey) - BASE_FAILURE_DELAY_MS : 0;
      await new Promise((r) => setTimeout(r, BASE_FAILURE_DELAY_MS));
      passwordChecksInFlight--;
      released = true;
      if (escalationMs > 0) await new Promise((r) => setTimeout(r, escalationMs));
      return refuse(request, formPost, "Invalid password", 401, "invalid");
    }
  } finally {
    if (!released) passwordChecksInFlight--;
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
