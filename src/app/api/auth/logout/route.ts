import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/server/session";

/**
 * POST /api/auth/logout — clear the session cookie and redirect to /login.
 */
export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/login", request.url));
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });

  return response;
}
