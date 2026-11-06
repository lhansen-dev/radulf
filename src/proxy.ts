/**
 * Request proxy — gates every route behind a signed session cookie.
 *
 * When RADULF_AUTH_PASSWORD_HASH is unset, loopback requests pass without a
 * session. Foreign Host headers are rejected to block DNS rebinding.
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
  isAllowedUnauthenticatedHost,
  requestHost,
} from "@/server/session";

// Match everything except Next's own static chunks and the favicon. Named
// paths, not a suffix rule: an extension exemption also skipped every check
// below for a route such as `/api/cards/<id>/approve-plan.png`, and nothing
// here serves images by extension (there is no `public/`). `/_next/image`
// stays covered on purpose: the optimizer is unused, and exempting it left
// its one reachable surface unauthenticated.
export const config = {
  matcher: ["/((?!_next/static|favicon\\.ico$).*)"],
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
  // loopback host and port this request was addressed to, or the full
  // RADULF_ALLOWED_ORIGIN:
  // another localhost port must not count, since browsers treat every localhost port
  // as one site for cookies.
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (!isAllowedOrigin(origin, requestHost(request))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (!authEnabled()) {
    if (!isAllowedUnauthenticatedHost(requestHost(request))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (pathname === "/login" || pathname === "/api/auth/login") {
    return NextResponse.next();
  }
  // The liveness check answers a container HEALTHCHECK and a reverse proxy's
  // probe, neither of which has a session. It reveals nothing but that the
  // process is up and whether a restart is pending.
  if (pathname === "/api/health" && request.method === "GET") {
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
