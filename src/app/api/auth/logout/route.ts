import { NextResponse } from "next/server";
import { redirectBase, requestIsSecure, revokeSessions, SESSION_COOKIE } from "@/server/session";

/**
 * POST /api/auth/logout — sign out everywhere: void every session issued so
 * far, clear this browser's cookie, and redirect to /login. Only a signed-in
 * request reaches here; the proxy answers anything else with 401.
 */
export async function POST(request: Request) {
  await revokeSessions();
  const response = NextResponse.redirect(new URL("/login", redirectBase(request)), 303);
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
