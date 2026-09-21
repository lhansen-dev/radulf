// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// react-window needs ResizeObserver and real layout, neither of which jsdom
// has. The stand-in keeps the two things the transcript view depends on: the
// rendered row count, and an imperative handle whose scrollToRow refuses an
// index the list has not rendered yet, exactly as the real one does.
const listStub = vi.hoisted(() => {
  const element = { scrollHeight: 1000, scrollTop: 900, clientHeight: 100 };
  type ScrollToRow = (opts: { index: number; align?: string }) => void;
  const stub = {
    rowCount: 0,
    scrollToRow: vi.fn(),
    element,
    // One ref object for the whole test file: the real useListRef is stable
    // across renders, and the view's effects depend on that identity.
    ref: { current: null as null | { element: typeof element; scrollToRow: ScrollToRow } },
  };
  const scrollToRow: ScrollToRow = (opts) => {
    if (opts.index >= stub.rowCount) throw new RangeError(`Invalid index specified: ${opts.index}`);
    stub.scrollToRow(opts);
  };
  stub.ref.current = { element, scrollToRow };
  return stub;
});
vi.mock("react-window", () => ({
  List: ({ rowCount }: { rowCount: number }) => {
    listStub.rowCount = rowCount;
    return <div data-testid="transcript-list" data-rowcount={rowCount} />;
  },
  useListRef: () => listStub.ref,
  useDynamicRowHeight: () => 28,
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
let cardEvents: Array<Record<string, unknown>> = [];
let cardScoping: Array<Record<string, unknown>> = [];

beforeEach(() => {
  cleanup();
  cardStatus = "plan_review";
  cardEvents = [];
  cardScoping = [];
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
            events: cardEvents,
            scoping: cardScoping,
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
  it("shows the planner badge and each role's resolved provider, model, and reasoning level", async () => {
    render(<CardDetail />);

    expect(await screen.findByText(/Planned by/)).toBeTruthy();
    expect(screen.getByText("claude-subscription/opus")).toBeTruthy();
    expect(screen.getByText("anthropic/opus (medium)")).toBeTruthy();
    expect(screen.getByText("anthropic/sonnet (high)")).toBeTruthy();
    expect(screen.getByText("anthropic/default (off)")).toBeTruthy();
  });

  it.each([
    ["plan", "failed"],
    ["loop", "failed"],
    ["evaluate", "timeout"],
  ])("offers to retry a %s step that ended %s on a needs-attention card", async (kind, status) => {
    cardStatus = "needs_attention";
    cardRuns = [
      {
        id: `failed-${kind}`,
        kind,
        status,
        iterationsDone: 0,
        exitReason: `${kind} ${status}`,
        startedAt: "2026-07-17T10:00:00.000Z",
        endedAt: "2026-07-17T10:01:00.000Z",
        iterations: [],
      },
    ];

    render(<CardDetail />);

    expect(await screen.findByRole("button", { name: "Retry failed step" })).toBeTruthy();
  });

  it("points a card the planner questioned at its scoping thread, and offers to plan again", async () => {
    cardStatus = "needs_attention";
    cardRuns = [
      { id: "plan-q", kind: "plan", status: "completed", iterationsDone: 0, exitReason: "planner raised follow-up questions", startedAt: "", endedAt: "", iterations: [] },
    ];
    cardEvents = [
      { id: 1, runId: "plan-q", type: "plan.questions", payload: JSON.stringify({ questions: "1. Which module?" }), createdAt: "2026-09-21T10:00:00.000Z" },
    ];
    cardScoping = [{ id: 1, role: "planner", content: "1. Which module?", createdAt: "" }];

    render(<CardDetail />);

    expect(await screen.findByText("The planner needs more detail before it can plan this task")).toBeTruthy();
    // The questions are shown once — in the thread (as a rendered list), not
    // duplicated verbatim in the banner.
    expect(screen.queryByText("1. Which module?")).toBeNull();
    expect(screen.getByText("Which module?").tagName).toBe("LI");
    expect(screen.getByText("Planner asked")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Answer and plan again" })).toBeTruthy();
  });

  it("still shows questions raised before the thread existed", async () => {
    cardStatus = "needs_attention";
    cardRuns = [
      { id: "plan-q", kind: "plan", status: "completed", iterationsDone: 0, exitReason: "planner raised follow-up questions", startedAt: "", endedAt: "", iterations: [] },
    ];
    cardEvents = [
      { id: 1, runId: "plan-q", type: "plan.questions", payload: JSON.stringify({ questions: "1. Which module?" }), createdAt: "2026-09-21T10:00:00.000Z" },
    ];

    render(<CardDetail />);

    expect(await screen.findByText("1. Which module?")).toBeTruthy();
    expect(screen.queryByText("Planner asked")).toBeNull();
  });

  it("lets a needs-attention card change its model overrides before retrying", async () => {
    cardStatus = "needs_attention";
    cardRuns = [
      {
        id: "failed-evaluate",
        kind: "evaluate",
        status: "failed",
        iterationsDone: 0,
        exitReason: "evaluator failed: 402",
        startedAt: "2026-07-17T10:00:00.000Z",
        endedAt: "2026-07-17T10:01:00.000Z",
        iterations: [],
      },
    ];
    const baseFetch = globalThis.fetch;
    const patches: unknown[] = [];
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/providers/anthropic/models") {
        return Promise.resolve(
          new Response(JSON.stringify({ models: [{ value: "haiku", displayName: "Haiku" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url === "/api/cards/c1" && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      return baseFetch(url, init);
    }) as unknown as typeof fetch;

    render(<CardDetail />);

    expect(await screen.findByRole("button", { name: "Retry failed step" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit model overrides" }));
    const evaluatorSelect = (await screen.findByRole("option", { name: "Evaluator model: Haiku" }))
      .parentElement as HTMLSelectElement;
    fireEvent.change(evaluatorSelect, { target: { value: "haiku" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ plannerModel: null, loopModel: null, evaluatorModel: "haiku" });
  });

  // The plan lives on the Task tab, which is the default — no click needed.
  it.each([
    ["planning", "Plan is running…"],
    ["todo", "No plan yet — start the task to run planning."],
  ])("shows a %s card with no plan as %j", async (status, text) => {
    cardStatus = status;
    cardPlans = [];

    render(<CardDetail />);

    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("offers only Task and Activity tabs, with the plan documents on Task", async () => {
    render(<CardDetail />);

    const tabs = (await screen.findAllByRole("tab")).map((t) => t.textContent);
    expect(tabs).toEqual(["Task", "Activity"]);
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

  /** A live transcript that arrives in two chunks: the historical load, then
   * an appended tail. Returns the fetch spy so a test can count the reads. */
  function liveTranscriptInTwoChunks() {
    cardStatus = "looping";
    cardRuns = [
      { id: "r1", kind: "plan", status: "completed", iterationsDone: 0, exitReason: null, startedAt: "2026-07-17T10:00:00.000Z", endedAt: "2026-07-17T10:01:00.000Z", provider: "anthropic", model: "opus", planId: "p1", iterations: [] },
    ];
    const baseFetch = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/runs/")) {
        reads += 1;
        const body = reads === 1
          ? { lines: [{ t: "text", role: "assistant", content: "one" }], cursor: 10, hasMore: true, truncated: false, reset: false }
          : { lines: [{ t: "text", role: "assistant", content: "two" }], cursor: 20, hasMore: false, truncated: false, reset: false };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return baseFetch(url, init);
    }) as unknown as typeof fetch;
    listStub.rowCount = 0;
    listStub.scrollToRow.mockClear();
  }

  it("follows a live transcript's tail only once the new rows are rendered", async () => {
    liveTranscriptInTwoChunks();
    listStub.element.scrollTop = 900; // sitting at the bottom

    render(<CardDetail />);
    fireEvent.click(await screen.findByRole("tab", { name: "Activity" }));
    fireEvent.click(await screen.findByRole("button", { name: /Planning/ }));
    fireEvent.click(screen.getByRole("button", { name: "view transcript" }));

    await waitFor(() => expect(listStub.rowCount).toBe(2));
    // Fired after each commit while following, for the row count the list
    // actually has — never for a row it did not have yet, which is what threw
    // RangeError before. The stub throws on such an index, so reaching the
    // final call proves every earlier one was in range too.
    await waitFor(() => expect(listStub.scrollToRow).toHaveBeenLastCalledWith({ index: 1, align: "end" }));
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("offers Jump to latest instead of stealing the scroll position when the reader is not at the bottom", async () => {
    liveTranscriptInTwoChunks();
    listStub.element.scrollTop = 0; // scrolled up, reading

    render(<CardDetail />);
    fireEvent.click(await screen.findByRole("tab", { name: "Activity" }));
    fireEvent.click(await screen.findByRole("button", { name: /Planning/ }));
    fireEvent.click(screen.getByRole("button", { name: "view transcript" }));

    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeTruthy();
    expect(listStub.scrollToRow).not.toHaveBeenCalled();
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
