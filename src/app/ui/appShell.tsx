"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const destinations = [
  { href: "/", label: "Work", icon: "▤" },
  { href: "/analytics", label: "Activity", icon: "◫" },
  { href: "/benchmarks", label: "Benchmarks", icon: "◷" },
  { href: "/settings", label: "Settings", icon: "⚙" },
  // No separate "Info" destination: it was a hardcoded React page duplicating
  // the Docs tab's Start-here group, and being JSX rather than markdown nothing
  // kept it honest — it still described the pre-spec-13 harness-per-provider
  // model. Docs reads from disk, so it cannot drift the same way.
  { href: "/docs", label: "Docs", icon: "▦" },
];

export function AppShell({
  children,
  onNewTask,
}: {
  children: ReactNode;
  onNewTask?: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="app-shell min-h-dvh">
      <aside className="desktop-rail" aria-label="Primary navigation">
        <Link href="/" className="brand-mark" aria-label="Radulf Work">
          R
        </Link>
        <nav className="flex flex-col gap-1">
          {destinations.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`rail-link ${active ? "rail-link-active" : ""}`}
              >
                <span aria-hidden="true" className="text-lg">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="rail-footer">
          {onNewTask && (
            <button type="button" onClick={onNewTask} className="rail-new-task">
              <span aria-hidden="true">＋</span>
              <span>Task</span>
            </button>
          )}
          <a
            href="https://github.com/lhansen-dev/radulf"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Radulf on GitHub"
            className="rail-repo-link"
          >
            GitHub
          </a>
        </div>
      </aside>

      <div className="min-w-0">{children}</div>

      {onNewTask && (
        <button type="button" onClick={onNewTask} className="mobile-new-task" aria-label="New task">
          <span aria-hidden="true">＋</span>
        </button>
      )}
      <nav className="bottom-nav" aria-label="Primary navigation">
        {destinations.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`bottom-nav-link ${active ? "bottom-nav-link-active" : ""}`}
            >
              <span aria-hidden="true" className="text-lg leading-none">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

