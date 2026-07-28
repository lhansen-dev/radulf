// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ReviewPage from "./page";

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
}));

beforeEach(() => {
  cleanup();

  const mockFetch = vi.fn((url: string) => {
    if (url === "/api/cards/c1") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            card: { id: "c1", title: "T", status: "review" },
            plans: [
              { version: 1, planMd: "## Tasks", acceptanceCriteria: "" },
            ],
            runs: [
              {
                id: "r1",
                kind: "plan",
                status: "completed",
                iterationsDone: 0,
                startedAt: "",
                endedAt: null,
                provider: "anthropic",
                model: "sonnet",
                iterations: [],
              },
              {
                id: "r2",
                kind: "loop",
                status: "completed",
                iterationsDone: 1,
                startedAt: "",
                endedAt: null,
                iterations: [{ n: 1, summary: null }],
              },
              {
                id: "r3",
                kind: "evaluate",
                status: "completed",
                iterationsDone: 0,
                exitReason: "approve",
                startedAt: "",
                endedAt: null,
                provider: "anthropic",
                model: "opus",
                iterations: [],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url === "/api/cards/c1/diff") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            runId: "r2",
            branch: "b",
            diff: "",
            stat: "",
            done: null,
            evaluation: "VERDICT: approve\n\nAll acceptance criteria passed.",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });

  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

describe("ReviewPage", () => {
  it("renders the Planned by badge with the model tag", async () => {
    render(<ReviewPage />);

    expect(await screen.findByText(/Planned by/)).toBeTruthy();
    expect(screen.getByText("claude-subscription/sonnet")).toBeTruthy();
    expect(screen.getByText(/Evaluator approved this change/)).toBeTruthy();
    expect(screen.getByText("All acceptance criteria passed.")).toBeTruthy();
  });
});

describe("ReviewPage — Phase 4 diff hardening banners", () => {
  function mockDiff(diff: string) {
    const mockFetch = vi.fn((url: string) => {
      if (url === "/api/cards/c1") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              card: { id: "c1", title: "T", status: "review" },
              plans: [],
              runs: [
                {
                  id: "r2",
                  kind: "loop",
                  status: "completed",
                  iterationsDone: 1,
                  startedAt: "",
                  endedAt: null,
                  iterations: [],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/api/cards/c1/diff") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ runId: "r2", branch: "b", diff, stat: "", done: null, evaluation: null }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  }

  it("flags a sensitive-path change distinctly from the general self-modifying banner", async () => {
    mockDiff(
      "diff --git a/src/server/sandbox/pathGuard.ts b/src/server/sandbox/pathGuard.ts\n" +
        "index 111..222 100644\n--- a/src/server/sandbox/pathGuard.ts\n+++ b/src/server/sandbox/pathGuard.ts\n" +
        "@@ -1 +1 @@\n-old\n+new\n",
    );
    render(<ReviewPage />);
    expect(await screen.findByText(/Touches sandbox \/ security-critical code/)).toBeTruthy();
    expect(screen.getByText(/self-modifying \/ load-bearing diff/i)).toBeTruthy();
  });

  it("flags a .gitattributes change", async () => {
    mockDiff(
      "diff --git a/.gitattributes b/.gitattributes\nindex 111..222 100644\n--- a/.gitattributes\n+++ b/.gitattributes\n" +
        "@@ -0,0 +1 @@\n+secret.txt -diff\n",
    );
    render(<ReviewPage />);
    expect(await screen.findByText(/\.gitignore \/ \.gitattributes changed/)).toBeTruthy();
  });

  it("renders a bidi-override character as a visible labeled escape", async () => {
    mockDiff(
      "diff --git a/src/app/page.tsx b/src/app/page.tsx\nindex 111..222 100644\n--- a/src/app/page.tsx\n+++ b/src/app/page.tsx\n" +
        "@@ -1 +1 @@\n+if (isAdmin) ‮return false;\n",
    );
    render(<ReviewPage />);
    expect(await screen.findByText(/Invisible or confusable characters/)).toBeTruthy();
    expect(screen.getByTitle(/RIGHT-TO-LEFT OVERRIDE/)).toBeTruthy();
  });

  it("shows no extra banners for an ordinary clean diff", async () => {
    mockDiff(
      "diff --git a/src/app/page.tsx b/src/app/page.tsx\nindex 111..222 100644\n--- a/src/app/page.tsx\n+++ b/src/app/page.tsx\n" +
        "@@ -1 +1 @@\n-old\n+new\n",
    );
    render(<ReviewPage />);
    await screen.findAllByText("src/app/page.tsx");
    expect(screen.queryByText(/Touches sandbox/)).toBeNull();
    expect(screen.queryByText(/gitattributes changed/)).toBeNull();
    expect(screen.queryByText(/Invisible or confusable/)).toBeNull();
  });
});
