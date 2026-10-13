import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { getSettings } from "@/server/settings";
import { authEnabled, SESSION_COOKIE, verifySession } from "@/server/session";
import "./globals.css";

export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Radulf",
  description: "An operations workspace for autonomous software tasks",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const settings = getSettings();
  // The login page renders through this layout too, and the banner states the
  // host's sandbox posture: only a signed-in operator should read it.
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const signedIn = !authEnabled() || (session ? await verifySession(session) : false);
  return (
    <html
      lang="en"
      data-theme={settings.theme || "default"}
      // Lets CSS show the sign-out control only when there is a session to end.
      data-auth={authEnabled() ? "on" : undefined}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-screen flex flex-col">
        {signedIn && !settings.sandboxEnabled && (
          <aside aria-label="Sandbox warning" className="shrink-0 bg-red-700 px-4 py-1.5 text-center text-xs font-medium text-white">
            Sandbox is OFF (Settings → sandboxEnabled) — agent bash runs unsandboxed on this
            host. Every affected run is stamped <code>sandboxed: false</code>.
          </aside>
        )}
        {children}
      </body>
    </html>
  );
}
