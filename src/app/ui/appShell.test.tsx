// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AppShell } from "./appShell";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: Record<string, unknown>) =>
    (props as { href?: string }).href ? <a href={(props as { href?: string }).href}>{children as React.ReactNode}</a> : <span>{children as React.ReactNode}</span>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

describe("AppShell", () => {
  beforeEach(cleanup);

  it("renders Benchmarks and Docs in both the desktop rail and mobile nav, and no Info", () => {
    render(
      <AppShell>
        <div>content</div>
      </AppShell>,
    );

    for (const [name, href] of [[/benchmarks/i, "/benchmarks"], [/docs/i, "/docs"]] as const) {
      const links = screen.getAllByRole("link", { name });
      expect(links).toHaveLength(2);
      for (const link of links) expect(link.getAttribute("href")).toBe(href);
    }
    // Docs absorbed the old Info destination.
    expect(screen.queryAllByRole("link", { name: /^info$/i })).toHaveLength(0);
  });

  it.each([
    ["with", () => {}],
    ["without", undefined],
  ])("ends the rail footer with the GitHub link %s a New task action", (_label, onNewTask) => {
    const { container } = render(
      <AppShell onNewTask={onNewTask}>
        <div>content</div>
      </AppShell>,
    );
    const rail = container.querySelector(".desktop-rail")!;
    expect(rail.querySelector(".rail-footer")).not.toBeNull();
    const last = Array.from(rail.querySelectorAll("a, button")).at(-1)!;
    expect(last.getAttribute("href")).toContain("https://github.com/lhansen-dev/radulf");
    expect(screen.getByRole("link", { name: /radulf on github/i })).toBe(last);
  });
});
