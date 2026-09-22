/**
 * Request proxy — gates every route behind a signed session cookie.
 *
 * When RADULF_AUTH_PASSWORD_HASH is unset, the proxy is a strict no-op so
 * the unauthenticated local-development behavior is preserved.
 *
 * Uses only Web Crypto (no fs, no bcrypt) — the HMAC secret is read from
 * process.env.RADULF_AUTH_SECRET, populated at boot by ensureAuthSecret().
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  authEnabled,
  verifySession,
  SESSION_COOKIE,
  isAllowedOrigin,
  requestHost,
} from "@/server/session";

// Match everything except Next.js internals and static assets.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

export async function proxy(request: NextRequest) {
  // CSRF backstop, applied BEFORE the auth and login-path exemptions below.
  //
  // Unconditional, because the no-auth default is exactly when it matters most:
  // Radulf drives coding agents with --dangerously-skip-permissions, so a page
  // the operator merely visits must not be able to blind-POST to their
  // localhost and flip sandboxEnabled, repoint omlxBaseUrl, or drive the
  // orchestrator. A cross-origin JSON fetch is preflighted away, but a
  // `text/plain` body is a CORS *simple* request that reaches the handler
  // unpreflighted — the response is unreadable, the mutation still lands.
  //
  // /api/auth/login is inside this check (it is exempted only from the session
  // check further down), otherwise an attacker page could force a session of
  // its choosing onto the operator's browser.
  //
  // Non-browser clients (curl, scripts) send no Origin at all and are
  // unaffected: isAllowedOrigin(null) is true. Only a foreign Origin is
  // rejected, and only browsers attach one. "Foreign" means anything but the
  // host and port this request was addressed to (or RADULF_ALLOWED_ORIGIN):
  // another localhost port counts, since browsers treat every localhost port
  // as one site for cookies.
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (!isAllowedOrigin(origin, requestHost(request))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (!authEnabled()) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (pathname === "/login" || pathname === "/api/auth/login") {
    return NextResponse.next();
  }

  const sessionValue = request.cookies.get(SESSION_COOKIE)?.value;
  const valid = sessionValue ? await verifySession(sessionValue) : false;
  if (!valid) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}
