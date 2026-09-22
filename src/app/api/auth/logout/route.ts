import { NextResponse } from "next/server";
import { redirectBase, requestIsSecure, SESSION_COOKIE } from "@/server/session";

/**
 * POST /api/auth/logout — clear the session cookie and redirect to /login.
 */
export async function POST(request: Request) {
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
