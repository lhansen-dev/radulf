// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AppShell } from "./appShell";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: Record<string, unknown>) =>
    (props as { href?: string }).href ? <a href={(props as { href?: string }).href}>{children as React.ReactNode}</a> : <span>{children as React.ReactNode}</span>,
}));

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
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

  it("leaves focus alone on a first load, and moves it to the new page's heading after navigating", async () => {
    const nextFrame = () => act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    nav.pathname = "/";
    const first = render(<AppShell><main><h1>Work</h1></main></AppShell>);
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
    first.unmount();

    // Each page mounts its own shell; the new one must still notice the move.
    nav.pathname = "/settings";
    render(<AppShell><main><h1>Settings</h1></main></AppShell>);
    await nextFrame();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Settings" }));
    nav.pathname = "/";
  });
});
