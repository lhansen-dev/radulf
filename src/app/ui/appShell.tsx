"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { OpenTasksStrip } from "./openTasksStrip";

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

/** The path the previous page was on, across AppShell instances: each page
 * mounts its own shell, so component state cannot tell a navigation from a
 * first load. Null until the first page has rendered. */
let lastPathname: string | null = null;

/** Spec 10: after navigating, focus moves to the new page's heading, so a
 * screen reader announces where you landed instead of starting from the top.
 * A first load keeps the browser's own focus. Pages that load their data
 * first render the heading a moment later, so this waits for it. */
function useFocusHeadingOnNavigation(pathname: string) {
  useEffect(() => {
    const navigated = lastPathname !== null && lastPathname !== pathname;
    lastPathname = pathname;
    if (!navigated) return;
    let frame = 0;
    let tries = 0;
    const focusHeading = () => {
      const heading = document.querySelector<HTMLElement>("main h1") ?? document.querySelector<HTMLElement>("h1");
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      } else if (++tries < 120) {
        frame = requestAnimationFrame(focusHeading);
      }
    };
    frame = requestAnimationFrame(focusHeading);
    return () => cancelAnimationFrame(frame);
  }, [pathname]);
}

export function AppShell({
  children,
  onNewTask,
}: {
  children: ReactNode;
  onNewTask?: () => void;
}) {
  const pathname = usePathname();
  useFocusHeadingOnNavigation(pathname);

  return (
    <div className="app-shell min-h-dvh">
      <aside className="desktop-rail" aria-label="Primary navigation">
        <Link href="/" className="brand-mark" aria-label="Radulf Work">
          R
        </Link>
        <nav className="flex flex-col gap-1">
          <NavLinks pathname={pathname} variant="rail" />
        </nav>
        <div className="rail-footer">
          {onNewTask && (
            <button type="button" onClick={onNewTask} className="rail-new-task">
              <span aria-hidden="true">+</span>
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

      <div className="min-w-0">
        <OpenTasksStrip pathname={pathname} />
        {children}
      </div>

      {onNewTask && (
        <button type="button" onClick={onNewTask} className="mobile-new-task" aria-label="New task">
          <span aria-hidden="true">+</span>
        </button>
      )}
      <nav className="bottom-nav" aria-label="Primary navigation">
        <NavLinks pathname={pathname} variant="bottom-nav" />
      </nav>
    </div>
  );
}

/** The destinations as links, styled by the `.rail-link` or `.bottom-nav-link`
 * rules in globals.css. */
function NavLinks({ pathname, variant }: { pathname: string; variant: "rail" | "bottom-nav" }) {
  return destinations.map((item) => {
    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={`${variant}-link ${active ? `${variant}-link-active` : ""}`}
      >
        <span aria-hidden="true" className={variant === "rail" ? "text-lg" : "text-lg leading-none"}>{item.icon}</span>
        <span>{item.label}</span>
      </Link>
    );
  });
}

