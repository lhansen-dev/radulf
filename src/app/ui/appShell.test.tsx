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

  it("renders a link to the GitHub repo with correct href and accessible name", () => {
    render(
      <AppShell>
        <div>content</div>
      </AppShell>
    );

    const link = screen.getByRole("link", { name: /radulf on github/i });
    expect(link.getAttribute("href")).toContain("https://github.com/lhansen-dev/radulf");
  });

  it("renders the Benchmarks destination in both navs", () => {
    render(
      <AppShell>
        <div>content</div>
      </AppShell>
    );

    // Desktop rail + mobile bottom nav each render the destination once
    const links = screen.getAllByRole("link", { name: /benchmarks/i });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.getAttribute("href")).toBe("/benchmarks");
  });

  it("no longer offers an Info destination — Docs absorbed it", () => {
    render(
      <AppShell>
        <div>content</div>
      </AppShell>
    );

    expect(screen.queryAllByRole("link", { name: /^info$/i })).toHaveLength(0);
  });

  it("renders the Docs destination in both navs", () => {
    render(
      <AppShell>
        <div>content</div>
      </AppShell>
    );

    const links = screen.getAllByRole("link", { name: /docs/i });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.getAttribute("href")).toBe("/docs");
  });

  it("has rail-footer with GitHub link as last button/link when onNewTask is provided", () => {
    const { container } = render(
      <AppShell onNewTask={() => {}}>
        <div>content</div>
      </AppShell>
    );
    const rail = container.querySelector(".desktop-rail");
    expect(rail).not.toBeNull();
    const footer = rail!.querySelector(".rail-footer");
    expect(footer).not.toBeNull();
    const allInteractive = Array.from(rail!.querySelectorAll("a, button"));
    const last = allInteractive[allInteractive.length - 1];
    expect(last.getAttribute("href")).toContain("https://github.com/lhansen-dev/radulf");
    expect(last.getAttribute("aria-label")).toMatch(/radulf on github/i);
  });

  it("has rail-footer with GitHub link as last button/link when onNewTask is not provided", () => {
    const { container } = render(
      <AppShell>
        <div>content</div>
      </AppShell>
    );
    const rail = container.querySelector(".desktop-rail");
    expect(rail).not.toBeNull();
    const footer = rail!.querySelector(".rail-footer");
    expect(footer).not.toBeNull();
    const allInteractive = Array.from(rail!.querySelectorAll("a, button"));
    const last = allInteractive[allInteractive.length - 1];
    expect(last.getAttribute("href")).toContain("https://github.com/lhansen-dev/radulf");
    expect(last.getAttribute("aria-label")).toMatch(/radulf on github/i);
  });
});