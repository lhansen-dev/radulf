import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  signSession,
  redirectBase,
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

// ── Route ─────────────────────────────────────────────────────

export async function POST(request: Request) {
  const clientKey = loginClientKey(request);

  // Pluck password from the body (form-encoded or JSON)
  const ct = request.headers.get("content-type") ?? "";
  let password = "";
  try {
    if (ct.includes("json")) {
      const body = await request.json();
      password = String(body.password ?? "");
    } else {
      const form = await request.formData();
      password = String(form.get("password") ?? "");
    }
  } catch {
    return err("Invalid request body", 400);
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

  const hash = process.env.RADULF_AUTH_PASSWORD_HASH;
  if (!hash || !bcrypt.compareSync(password, hash)) {
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
    secure: new URL(request.url).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1_000),
    expires: new Date(expiresAtMs),
  });

  return response;
}
