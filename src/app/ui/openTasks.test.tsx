// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { taskIdFromPath, useOpenTasks } from "./openTasks";
import { OpenTasksStrip } from "./openTasksStrip";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: Record<string, unknown>) => (
    <a href={href as string} aria-current={rest["aria-current"] as "page" | undefined} title={rest.title as string | undefined}>
      {children as React.ReactNode}
    </a>
  ),
}));

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  close() {}
}

const jsonResponse = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  localStorage.clear();
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
});

afterEach(() => cleanup());

describe("taskIdFromPath", () => {
  it.each([
    ["/card/abc", "abc"],
    ["/review/x-1?tab=activity", "x-1"],
    ["/", null],
    ["/settings", null],
    ["/card/", null],
  ])("reads %s as %j", (path, id) => {
    expect(taskIdFromPath(path)).toBe(id);
  });
});

describe("useOpenTasks", () => {
  it("opens the task a page is about once, keeps the list in storage, closes on request, prunes, and caps at eight", () => {
    localStorage.setItem("radulf.openTasks", JSON.stringify(["a"]));
    const { result, rerender } = renderHook(({ pathname }: { pathname: string }) => useOpenTasks(pathname), {
      initialProps: { pathname: "/card/b" },
    });
    expect(result.current.ids).toEqual(["a", "b"]);

    rerender({ pathname: "/review/a" });
    rerender({ pathname: "/settings" });
    expect(result.current.ids).toEqual(["a", "b"]);

    act(() => result.current.close("a"));
    expect(result.current.ids).toEqual(["b"]);
    expect(JSON.parse(localStorage.getItem("radulf.openTasks")!)).toEqual(["b"]);

    for (const id of ["c", "d", "e", "f", "g", "h", "i", "j"]) rerender({ pathname: `/card/${id}` });
    expect(result.current.ids).toEqual(["c", "d", "e", "f", "g", "h", "i", "j"]);

    act(() => result.current.prune(new Set(["c", "j"])));
    expect(result.current.ids).toEqual(["c", "j"]);
    expect(JSON.parse(localStorage.getItem("radulf.openTasks")!)).toEqual(["c", "j"]);
  });

  it("starts empty when storage holds garbage", () => {
    localStorage.setItem("radulf.openTasks", "not json");
    const { result } = renderHook(() => useOpenTasks("/card/z"));
    expect(result.current.ids).toEqual(["z"]);
  });
});

describe("OpenTasksStrip", () => {
  it("shows nothing until a task is opened, then names each open task, marks the current one, and closes on the ×", async () => {
    globalThis.fetch = vi.fn(() =>
      jsonResponse([
        { id: "a", title: "Add the limiter", status: "looping", latestRun: { id: "r1" } },
        { id: "b", title: "Docs", status: "review", latestRun: null },
      ]),
    ) as unknown as typeof fetch;
    const { container, rerender } = render(<OpenTasksStrip pathname="/" />);
    expect(container.innerHTML).toBe("");

    rerender(<OpenTasksStrip pathname="/card/a" />);
    rerender(<OpenTasksStrip pathname="/review/b" />);

    const current = await screen.findByRole("link", { name: "Docs" });
    expect(current.getAttribute("aria-current")).toBe("page");
    // A task in review links to its review page; the rest to the card.
    expect(current.getAttribute("href")).toBe("/review/b");
    expect(screen.getByRole("link", { name: "Add the limiter" }).getAttribute("href")).toBe("/card/a");

    fireEvent.click(screen.getByRole("button", { name: "Close Add the limiter" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Add the limiter" })).toBeNull());
    expect(JSON.parse(localStorage.getItem("radulf.openTasks")!)).toEqual(["b"]);
  });

  it("drops a tab whose task no longer exists once the card list says so", async () => {
    localStorage.setItem("radulf.openTasks", JSON.stringify(["gone", "b"]));
    globalThis.fetch = vi.fn(() => jsonResponse([{ id: "b", title: "Docs", status: "backlog", latestRun: null }])) as unknown as typeof fetch;

    render(<OpenTasksStrip pathname="/" />);

    await screen.findByRole("link", { name: "Docs" });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("radulf.openTasks")!)).toEqual(["b"]));
    expect(screen.queryByRole("button", { name: "Close Loading…" })).toBeNull();
  });
});
