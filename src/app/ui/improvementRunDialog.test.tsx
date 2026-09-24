// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImprovementRunDialog } from "./improvementRunDialog";

afterEach(cleanup);

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: Record<string, unknown>) =>
    (props as { href?: string }).href ? <a href={(props as { href?: string }).href}>{children as React.ReactNode}</a> : <span>{children as React.ReactNode}</span>,
}));

const repo = { id: "r", name: "Repo", path: "/r", defaultBranch: "main", approvedInstallScripts: "[]", gateCommand: null, createdAt: "" };

beforeEach(() => {
  vi.stubGlobal("confirm", () => false);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const requestPath = String(url);
    if (requestPath === "/api/settings") {
      return { ok: true, json: async () => ({ plannerProvider: "p", loopProvider: "l", evaluatorProvider: "e" }) };
    }
    if (requestPath.includes("/providers/")) {
      return { ok: true, json: async () => ({ models: [] }) };
    }
    if (requestPath.includes("/branches")) {
      return { ok: true, json: async () => ["main", "develop"] };
    }
    return { ok: true, json: async () => ({}) };
  })) as unknown as typeof fetch;
});

describe("ImprovementRunDialog", () => {
  it("defaults the base branch to the repo's default branch once branches load", async () => {
    render(<ImprovementRunDialog repos={[repo]} onClose={() => {}} onCreated={() => {}} />);
    await waitFor(() => {
      expect((screen.getByLabelText("Base branch") as HTMLSelectElement).value).toBe("main");
    });
  });

  it("submits the budget converted to minutes and the chosen base branch", async () => {
    const fetchMock = vi.mocked(fetch);
    const user = userEvent.setup();
    render(<ImprovementRunDialog repos={[repo]} onClose={() => {}} onCreated={() => {}} />);

    await waitFor(() => expect((screen.getByLabelText("Base branch") as HTMLSelectElement).value).toBe("main"));
    await user.selectOptions(screen.getByLabelText("Unit"), "hours");
    await user.clear(screen.getByLabelText("Time budget"));
    await user.type(screen.getByLabelText("Time budget"), "2");
    await user.click(screen.getByText("Start run"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]: unknown[]) => url === "/api/improvement-runs");
      expect(call).toBeDefined();
      const body = JSON.parse((call as [string, RequestInit])[1].body as string);
      expect(body).toEqual({
        repoId: "r",
        baseBranch: "main",
        budgetMinutes: 120,
        focusPrompt: "",
        plannerModel: "",
        loopModel: "",
        evaluatorModel: "",
        maxIterations: "",
        timeoutMinutes: "",
      });
    });
  });

  // The enabled case alone proves nothing here: the dialog opens with a valid
  // budget ("30") and auto-selects a base branch, so every term of
  // `busy || !repoId || !baseBranch || !budgetValid` is already false before
  // the assertion runs. Deleting the whole `disabled` prop would leave that
  // passing. Drive the budget to each value that should disable it instead.
  it("disables Start run until a positive budget and base branch are set", async () => {
    const user = userEvent.setup();
    render(<ImprovementRunDialog repos={[repo]} onClose={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText("Base branch") as HTMLSelectElement).value).toBe("main"));
    const startRun = () => screen.getByText("Start run") as HTMLButtonElement;
    const budget = screen.getByLabelText("Time budget") as HTMLInputElement;

    expect(startRun().disabled).toBe(false);

    await user.clear(budget);
    expect(startRun().disabled).toBe(true);

    await user.type(budget, "0");
    expect(startRun().disabled).toBe(true);

    await user.clear(budget);
    await user.type(budget, "45");
    expect(startRun().disabled).toBe(false);
  });
});
