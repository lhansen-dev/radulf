import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getSettings } from "@/server/settings";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const settings = getSettings();
  return (
    <html
      lang="en"
      data-theme={settings.theme || "default"}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-screen flex flex-col">
        {!settings.sandboxEnabled && (
          <div className="shrink-0 bg-red-700 px-4 py-1.5 text-center text-xs font-medium text-white">
            Sandbox is OFF (Settings → sandboxEnabled) — agent bash runs unsandboxed on this
            host. Every affected run is stamped <code>sandboxed: false</code>.
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
