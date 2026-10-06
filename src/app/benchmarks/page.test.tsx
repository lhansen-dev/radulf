// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import BenchmarksPage from "./page";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/benchmarks",
}));

describe("BenchmarksPage", () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("launches with models picked from the Settings providers' listings", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/benchmarks" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ reportFile: "report.json", logFile: "report.log" }, 201));
      }
      if (url === "/api/benchmarks") {
        return Promise.resolve(jsonResponse({
          fixtures: [{ name: "small-ui-change", title: "Small change", criteriaCount: 1, seeded: true }],
          reports: [],
          active: [],
          rollout: {
            windowSize: 0,
            requiredSampleSize: 30,
            accepted: null,
            sufficientSample: false,
            targets: [],
          },
        }));
      }
      if (url === "/api/repos") {
        return Promise.resolve(jsonResponse([{
          id: "repo-1",
          name: "Benchmark repo",
          path: "/tmp/benchmark",
          defaultBranch: "main",
          createdAt: "2026-07-16T00:00:00.000Z",
        }]));
      }
      if (url === "/api/settings") {
        return Promise.resolve(jsonResponse({
          loopProvider: "openrouter",
          loopModel: "fast/loop",
          plannerProvider: "anthropic",
          plannerModel: "strong/planner",
          evaluatorProvider: "chatgpt",
          evaluatorModel: "eval/model",
          criticProvider: "copilot",
          criticModel: "critic/model",
          planCriticMode: "breakdown",
        }));
      }
      if (url === "/api/providers/openrouter/models") {
        return Promise.resolve(jsonResponse({ models: [
          { value: "fast/loop", displayName: "Fast loop", description: "" },
          { value: "other/loop", displayName: "Other loop", description: "" },
        ] }));
      }
      if (url === "/api/providers/anthropic/models") {
        return Promise.resolve(jsonResponse({ models: [
          { value: "strong/planner", displayName: "Strong planner", description: "" },
        ] }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<BenchmarksPage />);

    const plannerInput = await screen.findByLabelText("Planner model");
    expect((plannerInput as HTMLInputElement).value).toBe("strong/planner");

    // Each picker lists its Settings provider's models; picking one from the
    // browser replaces the model id that would be launched.
    expect(screen.getByText(/Provider: OpenRouter/)).toBeTruthy();
    expect(screen.getByText(/Provider: Anthropic/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Other loop" }));
    expect((screen.getByLabelText("Loop model") as HTMLInputElement).value).toBe("other/loop");

    // "breakdown" mode skips the critic for a top-level card, so it starts off
    // and its picker stays hidden until switched on.
    expect((screen.getByLabelText("Evaluator model") as HTMLInputElement).value).toBe("eval/model");
    expect(screen.queryByLabelText("Plan critic model")).toBeNull();
    fireEvent.click(screen.getByLabelText("Run the plan critic"));
    expect((screen.getByLabelText("Plan critic model") as HTMLInputElement).value).toBe("critic/model");

    fireEvent.change(screen.getByLabelText("Fixture"), { target: { value: "small-ui-change" } });
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "repo-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Start benchmark" }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/benchmarks" && init?.method === "POST",
      );
      expect(request).toBeTruthy();
      expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
        provider: "openrouter",
        model: "other/loop",
        plannerModel: "strong/planner",
        evaluatorModel: "eval/model",
        criticModel: "critic/model",
        planCritic: true,
      });
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
