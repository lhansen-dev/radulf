// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { BoardCard } from "./ui/api";
import WorkPage from "./page";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

// The shell (nav, open-tasks strip) and the live activity dot each open their
// own fetches and event streams; neither is what these tests are about.
vi.mock("./ui/appShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./ui/liveActivity", () => ({ ActivityDot: () => null }));

const work = vi.hoisted(() => ({ cards: [] as BoardCard[] }));
vi.mock("./ui/useWorkData", () => ({
  useWorkData: () => ({
    cards: work.cards,
    setCards: () => {},
    repos: [],
    error: "",
    setError: () => {},
    loading: false,
    streamConnected: true,
    autoMode: false,
    setAutoMode: () => {},
    autoApprove: false,
    setAutoApprove: () => {},
    openPr: false,
    setOpenPr: () => {},
    improvementRuns: [],
    improvementAlert: null,
    dismissImprovementAlert: () => {},
    restartRequired: false,
    restarting: false,
    setRestarting: () => {},
    refetchCards: () => {},
    refetchImprovementRuns: () => {},
  }),
}));

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "c1",
    repoId: "repo-1",
    title: "Build the mixer",
    description: "",
    status: "looping",
    position: 1,
    source: "user",
    maxIterations: null,
    timeoutMinutes: null,
    startedAt: "2026-10-03T10:00:00.000Z",
    createdAt: "2026-10-03T09:00:00.000Z",
    updatedAt: "2026-10-03T10:00:00.000Z",
    repoName: "radulf",
    baseBranch: "main",
    parentCardId: null,
    runMode: null,
    dependsOn: null,
    latestRun: {
      id: "r1",
      kind: "loop",
      status: "running",
      iterationsDone: 3,
      exitReason: null,
      currentTask: { number: 3, count: 8, left: 6, text: "Add the level faders" },
      startedAt: "2026-10-03T10:00:00.000Z",
    },
    maxIterationsResolved: 50,
    plannerModelResolved: null,
    loopModelResolved: null,
    evaluatorModelResolved: null,
    summary: null,
    ...overrides,
  };
}

afterEach(cleanup);

describe("WorkPage", () => {
  it("shows a looping card's checklist progress as a bar", () => {
    work.cards = [card()];
    render(<WorkPage />);

    // Task 3 is the first unchecked one, so tasks 1 and 2 are done.
    const bar = screen.getByRole("progressbar", { name: "Tasks done" });
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("8");
    expect(bar.getAttribute("aria-valuetext")).toBe("2 of 8 tasks done");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("25%");
  });

  it("shows no bar when there is no checklist to measure", () => {
    // Planning has no checklist yet, and a loop whose plan has no unchecked
    // task left has nothing to count against.
    work.cards = [
      card({ id: "c1", status: "planning" }),
      card({ id: "c2", latestRun: { ...card().latestRun!, currentTask: null } }),
    ];
    render(<WorkPage />);

    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
