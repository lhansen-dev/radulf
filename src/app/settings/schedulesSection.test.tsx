// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SchedulesSection } from "./schedulesSection";
import type { Repo } from "../ui/api";

const repos = [
  { id: "repo-1", name: "Radulf", path: "/repos/radulf", defaultBranch: "beta", approvedInstallScripts: "[]", createdAt: "2026-09-01" },
] as unknown as Repo[];

/** What GET /api/schedules answers with. */
const drain = {
  id: "s1",
  kind: "queue-drain",
  repoId: null,
  cron: "0 3 * * *",
  enabled: 1,
  config: "{}",
  lastFiredAt: "2026-09-22T03:00:00.000Z",
  lastResult: "started 2 of 2 queued cards",
  lastError: null,
  upcoming: ["2026-09-23T03:00:00.000Z", "2026-09-24T03:00:00.000Z"],
};

let rows: unknown[];
let calls: { url: string; init?: RequestInit }[];

beforeEach(() => {
  cleanup();
  rows = [];
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/schedules" && (!init || init.method === undefined)) {
      return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  vi.stubGlobal("confirm", () => true);
});

const body = (index: number) => JSON.parse(String(calls[index].init?.body));

describe("SchedulesSection", () => {
  it("says nothing is scheduled when nothing is, which is the default", async () => {
    render(<SchedulesSection repos={repos} />);

    expect(await screen.findByText(/Radulf starts work only when you do/)).toBeTruthy();
  });

  it("shows a schedule's scope, expression, upcoming fires and last result", async () => {
    rows = [drain];
    render(<SchedulesSection repos={repos} />);

    expect(await screen.findByText("Drain the queue")).toBeTruthy();
    expect(screen.getByText("every repository")).toBeTruthy();
    expect(screen.getByText("0 3 * * *")).toBeTruthy();
    // The upcoming fires are how the expression reads back.
    expect(screen.getByText(/^Next .*, then /)).toBeTruthy();
    expect(screen.getByText(/started 2 of 2 queued cards/)).toBeTruthy();
  });

  it("warns about an enabled expression that can never fire", async () => {
    rows = [{ ...drain, cron: "0 0 30 2 *", upcoming: [] }];
    render(<SchedulesSection repos={repos} />);

    expect(await screen.findByText(/never matches, so it will never fire/)).toBeTruthy();
  });

  it("suspends and deletes through the id route", async () => {
    rows = [drain];
    render(<SchedulesSection repos={repos} />);

    fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.init?.method === "PATCH")!;
    expect(patch.url).toBe("/api/schedules/s1");
    expect(JSON.parse(String(patch.init?.body))).toEqual({ enabled: false });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "DELETE")).toBe(true));
  });

  it("creates a queue drain from an example expression", async () => {
    render(<SchedulesSection repos={repos} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add a schedule" }));
    fireEvent.click(screen.getByRole("button", { name: "weekdays at 02:00" }));
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST")).toBe(true));
    const post = calls.findIndex((c) => c.init?.method === "POST");
    expect(body(post)).toEqual({ kind: "queue-drain", repoId: null, cron: "0 2 * * 1-5", config: {} });
  });

  it("asks an improvement-run schedule for the repo and budget a run needs", async () => {
    render(<SchedulesSection repos={repos} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add a schedule" }));
    fireEvent.change(screen.getByLabelText("What to start"), { target: { value: "improvement-run" } });

    // A run is per repo, so saving is off until one is picked.
    expect((screen.getByRole("button", { name: "Save schedule" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "repo-1" } });
    fireEvent.change(screen.getByLabelText("Focus, optional"), { target: { value: " flaky tests " } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST")).toBe(true));
    const post = calls.findIndex((c) => c.init?.method === "POST");
    expect(body(post)).toEqual({
      kind: "improvement-run",
      repoId: "repo-1",
      cron: "0 3 * * *",
      // Blank base branch falls back to the repo's default rather than empty.
      config: { baseBranch: "beta", budgetMinutes: 90, focusPrompt: "flaky tests" },
    });
  });

  it("surfaces the server's reason for refusing an expression", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: "a cron expression has five fields" }), { status: 400 });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    render(<SchedulesSection repos={repos} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add a schedule" }));
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    expect((await screen.findByRole("alert")).textContent).toContain("five fields");
  });
});
