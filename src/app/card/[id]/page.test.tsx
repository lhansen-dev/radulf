// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CardDetail from "./page";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: Record<string, unknown>) =>
    (props as { href?: string }).href ? (
      <a href={(props as { href?: string }).href}>
        {children as React.ReactNode}
      </a>
    ) : (
      <span>{children as React.ReactNode}</span>
    ),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "c1" }),
  useRouter: () => ({ push: () => {} }),
  usePathname: () => "/card/c1",
}));

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  close() {}
}

let cardStatus = "plan_review";
let cardRuns: Array<Record<string, unknown>> = [];
let cardPlans: Array<Record<string, unknown>> = [];

beforeEach(() => {
  cleanup();
  cardStatus = "plan_review";
  cardRuns = [
    {
      id: "r1",
      kind: "plan",
      status: "completed",
      iterationsDone: 0,
      exitReason: null,
      startedAt: "",
      endedAt: "",
      provider: "anthropic",
      model: "opus",
      iterations: [],
    },
  ];
  cardPlans = [
    {
      id: "p1",
      version: 1,
      planMd: "## Tasks",
      promptMd: "",
      acceptanceCriteria: "",
      feedback: null,
      createdAt: "",
    },
  ];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

  const mockFetch = vi.fn((url: string) => {
    if (url === "/api/settings") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            plannerProvider: "anthropic",
            loopProvider: "anthropic",
            evaluatorProvider: "anthropic",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url === "/api/providers/anthropic/models") {
      return Promise.resolve(
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url === "/api/cards/c1") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            card: {
              id: "c1",
              title: "T",
              description: "",
              status: cardStatus,
              maxIterations: null,
              timeoutMinutes: null,
              plannerModel: null,
              loopModel: null,
              evaluatorModel: null,
              reviewPlanBeforeImplementation: 0,
              autoApprove: 0,
              summary: null,
              startedAt: null,
              createdAt: "",
              baseBranch: null,
            },
            repo: null,
            plans: cardPlans,
            runs: cardRuns,
            events: [],
            models: {
              planner: { provider: "anthropic", model: "opus", reasoningLevel: "medium" },
              loop: { provider: "anthropic", model: "sonnet", reasoningLevel: "high" },
              evaluator: { provider: "anthropic", model: null, reasoningLevel: "off" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    // The transcript drill-down loads its lines from here.
    if (url.startsWith("/api/runs/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ lines: [], cursor: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });

  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

describe("CardDetail", () => {
  it("renders the Planned by badge with the model tag", async () => {
    render(<CardDetail />);

    expect(await screen.findByText(/Planned by/)).toBeTruthy();
    expect(screen.getByText("claude-subscription/opus")).toBeTruthy();
  });

  it("shows the resolved planner/loop/evaluator provider, model, and reasoning level on the overview", async () => {
    render(<CardDetail />);

    expect(await screen.findByText("anthropic/opus (medium)")).toBeTruthy();
    expect(screen.getByText("anthropic/sonnet (high)")).toBeTruthy();
    expect(screen.getByText("anthropic/default (off)")).toBeTruthy();
  });

  it.each(["plan", "loop", "evaluate"])(
    "offers to retry a failed %s step on a needs-attention card",
    async (kind) => {
      cardStatus = "needs_attention";
      cardRuns = [
        {
          id: `failed-${kind}`,
          kind,
          status: "failed",
          iterationsDone: 0,
          exitReason: `${kind} failed`,
          startedAt: "2026-07-17T10:00:00.000Z",
          endedAt: "2026-07-17T10:01:00.000Z",
          iterations: [],
        },
      ];

      render(<CardDetail />);

      expect(await screen.findByRole("button", { name: "Retry failed step" })).toBeTruthy();
    },
  );

  it("offers to retry a failed evaluator from needs_attention", async () => {
    cardStatus = "needs_attention";
    cardRuns = [
      {
        id: "failed-evaluate",
        kind: "evaluate",
        status: "timeout",
        iterationsDone: 0,
        exitReason: "evaluation timed out",
        startedAt: "2026-07-17T10:00:00.000Z",
        endedAt: "2026-07-17T10:01:00.000Z",
        iterations: [],
      },
    ];

    render(<CardDetail />);

    expect(await screen.findByRole("button", { name: "Retry failed step" })).toBeTruthy();
  });

  // The plan lives on the Task tab, which is the default — no click needed.
  it("shows 'Plan is running…' when planning is active and no plan exists", async () => {
    cardStatus = "planning";
    cardPlans = [];

    render(<CardDetail />);

    expect(await screen.findByText("Plan is running…")).toBeTruthy();
  });

  it("shows 'No plan yet' fallback when status is todo and no plan exists", async () => {
    cardStatus = "todo";
    cardPlans = [];

    render(<CardDetail />);

    expect(await screen.findByText("No plan yet — start the task to run planning.")).toBeTruthy();
  });

  it("offers only Task and Activity tabs", async () => {
    render(<CardDetail />);

    const tabs = (await screen.findAllByRole("tab")).map((t) => t.textContent);
    expect(tabs).toEqual(["Task", "Activity"]);
  });

  it("renders the plan documents on the Task tab without a second tab", async () => {
    render(<CardDetail />);

    expect(await screen.findByText(/PLAN.md/)).toBeTruthy();
    expect(screen.getByText(/CRITERIA.md/)).toBeTruthy();
    expect(screen.getByText(/PROMPT.md/)).toBeTruthy();
  });

  it("drills from a run into its transcript and back, inside the Activity tab", async () => {
    cardStatus = "looping";
    cardRuns = [
      {
        id: "r1",
        kind: "plan",
        status: "completed",
        iterationsDone: 0,
        exitReason: null,
        startedAt: "2026-07-17T10:00:00.000Z",
        endedAt: "2026-07-17T10:01:00.000Z",
        provider: "anthropic",
        model: "opus",
        planId: "p1",
        iterations: [],
      },
    ];

    render(<CardDetail />);

    fireEvent.click(await screen.findByRole("tab", { name: "Activity" }));
    fireEvent.click(await screen.findByRole("button", { name: /Planning/ }));
    fireEvent.click(screen.getByRole("button", { name: "view transcript" }));

    // The transcript replaces the table, with a way back.
    const back = await screen.findByRole("button", { name: "← Back to runs" });
    expect(screen.queryByRole("button", { name: /Planning/ })).toBeNull();

    fireEvent.click(back);
    expect(await screen.findByRole("button", { name: /Planning/ })).toBeTruthy();
  });

  it("lands an old ?tab=plan link on Task and ?tab=transcript on Activity", async () => {
    window.history.replaceState({}, "", "/card/c1?tab=plan");
    render(<CardDetail />);

    const planTab = await screen.findByRole("tab", { name: "Task" });
    expect(planTab.getAttribute("aria-selected")).toBe("true");

    cleanup();
    window.history.replaceState({}, "", "/card/c1?tab=transcript");
    render(<CardDetail />);

    const activityTab = await screen.findByRole("tab", { name: "Activity" });
    expect(activityTab.getAttribute("aria-selected")).toBe("true");
    window.history.replaceState({}, "", "/card/c1");
  });
});
