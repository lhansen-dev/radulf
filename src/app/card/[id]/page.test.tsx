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
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
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

  it("shows 'Plan is running…' when planning is active and no plan exists", async () => {
    cardStatus = "planning";
    cardPlans = [];

    render(<CardDetail />);

    fireEvent.click(await screen.findByRole("tab", { name: "Plan" }));

    expect(await screen.findByText("Plan is running…")).toBeTruthy();
  });

  it("shows 'No plan yet' fallback when status is todo and no plan exists", async () => {
    cardStatus = "todo";
    cardPlans = [];

    render(<CardDetail />);

    fireEvent.click(await screen.findByRole("tab", { name: "Plan" }));

    expect(await screen.findByText("No plan yet — start the task to run planning.")).toBeTruthy();
  });
});
