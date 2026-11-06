import { NextResponse } from "next/server";
import { redirectBase, requestIsSecure, SESSION_COOKIE } from "@/server/session";
import { revokeAllSessions } from "@/server/sessionEpoch";

/**
 * POST /api/auth/logout: end every session, clear this browser's cookie and
 * redirect to /login.
 *
 * Every session, not only this browser's. Radulf has one password and one
 * operator, so there is no other account to keep signed in, and a cookie that
 * leaked is indistinguishable from the operator's own. Logging in from any
 * browser and logging out again is the kill switch for a leaked cookie, in
 * place of rotating data/auth-secret, which also made every stored provider
 * key undecryptable.
 */
export async function POST(request: Request) {
  revokeAllSessions();
  const response = NextResponse.redirect(new URL("/login", redirectBase(request)));
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: requestIsSecure(request),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });

  return response;
}
