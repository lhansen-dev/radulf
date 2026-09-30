// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BreakdownEditor } from "./breakdownEditor";

let calls: { url: string; init?: RequestInit }[];
let repos: { id: string; name: string }[];

beforeEach(() => {
  cleanup();
  calls = [];
  repos = [{ id: "r1", name: "Repo" }, { id: "r2", name: "Other" }];
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = url === "/api/repos" ? repos : { cards: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as unknown as typeof fetch;
});

const pieces = [
  { title: "Add the limiter", description: "a" },
  { title: "Surface the lockout", description: "b" },
];

describe("BreakdownEditor", () => {
  it("edits the run mode, order, membership and home of the pieces, then queues them", async () => {
    const onApplied = vi.fn();
    render(
      <BreakdownEditor cardId="c1" homeRepoId="r1" initialPieces={pieces} initialRunMode="ordered" onApplied={onApplied} onDiscard={() => {}} />,
    );

    expect((screen.getByLabelText("In order") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("In parallel"));
    fireEvent.click(screen.getByRole("button", { name: "Move task 2 up" }));
    expect((screen.getByLabelText("1. Title") as HTMLInputElement).value).toBe("Surface the lockout");
    fireEvent.click(screen.getByRole("button", { name: "＋ Add a task" }));
    fireEvent.change(screen.getByLabelText("3. Title"), { target: { value: "Document it" } });
    // The repository choice appears once more than one repository is known;
    // a piece kept at home sends no repoId.
    fireEvent.change(await screen.findByLabelText("1. Repository"), { target: { value: "r2" } });

    fireEvent.click(screen.getByRole("button", { name: "Queue 3 tasks" }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith("Queued 3 tasks under this epic, to run in parallel."));
    const apply = calls.find((call) => call.url === "/api/cards/c1/breakdown")!;
    expect(JSON.parse(String(apply.init?.body))).toEqual({
      pieces: [
        { title: "Surface the lockout", description: "b", repoId: "r2" },
        { title: "Add the limiter", description: "a" },
        { title: "Document it", description: "" },
      ],
      runMode: "parallel",
    });
  });

  it("picks dependencies as a graph and keeps them pointing at the same task when tasks move", async () => {
    const onApplied = vi.fn();
    render(
      <BreakdownEditor cardId="c1" homeRepoId="r1" initialPieces={pieces} initialRunMode="ordered" onApplied={onApplied} onDiscard={() => {}} />,
    );

    // Dependencies only mean something as a graph, so the other modes hide them.
    expect(screen.queryByText("Depends on")).toBeNull();
    expect(screen.queryByLabelText("Task 2 depends on task 1")).toBeNull();

    fireEvent.click(screen.getByLabelText("As a graph"));
    expect(screen.getAllByText("Depends on")).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("Task 2 depends on task 1"));
    expect((screen.getByLabelText("Task 2 depends on task 1") as HTMLInputElement).checked).toBe(true);

    // "Surface the lockout" moves to the front, and still depends on "Add the limiter", now task 2.
    fireEvent.click(screen.getByRole("button", { name: "Move task 2 up" }));
    expect((screen.getByLabelText("Task 1 depends on task 2") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Task 2 depends on task 1") as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Queue 2 tasks" }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith("Queued 2 tasks under this epic, to run as a graph."));
    const apply = calls.find((call) => call.url === "/api/cards/c1/breakdown")!;
    expect(JSON.parse(String(apply.init?.body))).toEqual({
      pieces: [
        { title: "Surface the lockout", description: "b", dependsOn: [1] },
        { title: "Add the limiter", description: "a" },
      ],
      runMode: "graph",
    });
  });

  it("will not queue a blank title, keeps at least one piece, and hides the repository choice with one repository", async () => {
    repos = [{ id: "r1", name: "Repo" }];
    render(
      <BreakdownEditor cardId="c1" homeRepoId="r1" initialPieces={pieces} initialRunMode="ordered" onApplied={() => {}} onDiscard={() => {}} />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Drop this task" })[0]);
    expect((screen.getByLabelText("1. Title") as HTMLInputElement).value).toBe("Surface the lockout");
    expect(screen.queryAllByRole("button", { name: "Drop this task" })).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("1. Title"), { target: { value: "  " } });
    expect((screen.getByRole("button", { name: "Queue 1 task" }) as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => expect(calls.some((call) => call.url === "/api/repos")).toBe(true));
    expect(screen.queryByLabelText("1. Repository")).toBeNull();
  });

  it("reports a refused breakdown and keeps the pieces for another try", async () => {
    globalThis.fetch = vi.fn((url: string) =>
      Promise.resolve(
        url === "/api/repos"
          ? new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response(JSON.stringify({ error: "this card is already planned" }), { status: 400, headers: { "Content-Type": "application/json" } }),
      ),
    ) as unknown as typeof fetch;
    render(
      <BreakdownEditor cardId="c1" homeRepoId="r1" initialPieces={pieces} initialRunMode="ordered" onApplied={() => {}} onDiscard={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Queue 2 tasks" }));

    expect((await screen.findByRole("alert")).textContent).toContain("already planned");
    expect((screen.getByLabelText("1. Title") as HTMLInputElement).value).toBe("Add the limiter");
    expect((screen.getByRole("button", { name: "Queue 2 tasks" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
