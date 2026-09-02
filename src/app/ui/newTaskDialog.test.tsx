// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewTaskDialog } from "./newTaskDialog";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: Record<string, unknown>) =>
    (props as { href?: string }).href ? <a href={(props as { href?: string }).href}>{children as React.ReactNode}</a> : <span>{children as React.ReactNode}</span>,
}));

beforeEach(() => {
  vi.stubGlobal("confirm", () => false);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      String(url).includes("/providers/")
        ? { models: [] }
        : { plannerProvider: "p", loopProvider: "l", evaluatorProvider: "e" },
  }))) as unknown as typeof fetch;
});

describe("NewTaskDialog", () => {
  it("keeps focus in the Title input while typing", async () => {
    const user = userEvent.setup();
    render(
      <NewTaskDialog
        repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", createdAt: "" }]}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    await user.click(title);
    await user.keyboard("a");
    expect(document.activeElement).toBe(title);
  });

  it("defaults to the scoped repo when defaultRepoId is provided", async () => {
    cleanup();
    const radulf = { id: "radulf", name: "radulf", path: "/r/radulf", defaultBranch: "main", createdAt: "" };
    const doomClone = { id: "doom", name: "doom-clone", path: "/r/doom", defaultBranch: "main", createdAt: "" };
    render(
      <NewTaskDialog
        repos={[radulf, doomClone]}
        defaultRepoId="doom"
        onClose={() => {}}
        onCreated={() => {}}
      />
    );
    const select = screen.getByLabelText("Repository") as HTMLSelectElement;
    expect(select.value).toBe("doom");
  });

  describe("with ChatGPT provider", () => {
    beforeEach(() => {
      cleanup(); // ensure previous render is removed
      vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          String(url).includes("/providers/")
            ? { models: [
                { value: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" },
                { value: "gpt-5.4", displayName: "GPT-5.4" },
              ]}
            : { plannerProvider: "chatgpt", loopProvider: "chatgpt", evaluatorProvider: "chatgpt" },
      })));
    });

    it("renders dynamic ChatGPT models in override dropdowns", async () => {
      const user = userEvent.setup();
      render(
        <NewTaskDialog
          repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", createdAt: "" }]}
          onClose={() => {}}
          onCreated={() => {}}
        />
      );

      const advanced = screen.getByText("Advanced");
      await user.click(advanced);

      const options = await screen.findAllByText("GPT-5.6-Sol");
      expect(options.length).toBeGreaterThanOrEqual(1);

      const providerLabels = await screen.findAllByText("ChatGPT (Codex subscription)", { exact: false });
      expect(providerLabels.length).toBeGreaterThan(0);
    });
  });

  it("submits all three model overrides in the complete card payload", async () => {
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const requestPath = String(url);
      if (requestPath === "/api/settings") {
        return {
          ok: true,
          json: async () => ({
            plannerProvider: "planner-provider",
            loopProvider: "loop-provider",
            evaluatorProvider: "evaluator-provider",
          }),
        };
      }
      const provider = requestPath.match(/\/api\/providers\/(.+)\/models/)?.[1];
      if (provider) {
        return {
          ok: true,
          json: async () => ({
            models: [{ value: `${provider}-model`, displayName: `${provider} model` }],
          }),
        };
      }
      return { ok: true, json: async () => [] };
    }));
    const fetchMock = vi.mocked(fetch);
    const user = userEvent.setup();
    render(
      <NewTaskDialog
        repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", createdAt: "" }]}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    await user.type(screen.getByLabelText("Title"), "Model-specific task");
    await user.click(screen.getByText("Advanced"));
    const chips = await screen.findAllByText("planner-provider model");
    expect(chips.length).toBeGreaterThanOrEqual(1);
    const plannerInput = screen.getByLabelText("Planner model");
    await user.clear(plannerInput);
    await user.type(plannerInput, "planner-provider-model");
    const loopInput = screen.getByLabelText("Loop model");
    await user.clear(loopInput);
    await user.type(loopInput, "loop-provider-model");
    const evaluatorInput = screen.getByLabelText("Evaluator model");
    await user.clear(evaluatorInput);
    await user.type(evaluatorInput, "evaluator-provider-model");
    await user.click(screen.getByText("Create task"));

    await waitFor(() => {
      const cardsCall = fetchMock.mock.calls.find(([url]: unknown[]) => url === "/api/cards");
      expect(cardsCall).toBeDefined();
      expect(JSON.parse((cardsCall as [string, RequestInit])[1].body as string)).toEqual({
        repoId: "r",
        title: "Model-specific task",
        description: "",
        plannerModel: "planner-provider-model",
        loopModel: "loop-provider-model",
        evaluatorModel: "evaluator-provider-model",
        maxIterations: "",
        timeoutMinutes: "",
        reviewPlanBeforeImplementation: false,
        autoApprove: false,
        baseBranch: null,
      });
    });
  });

  describe("Review plan before implementation", () => {
    beforeEach(() => {
      cleanup();
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (String(url).includes("/api/settings")) {
          return {
            ok: true,
            json: async () => ({ plannerProvider: "p", loopProvider: "l", evaluatorProvider: "e" }),
          };
        }
        if (String(url).includes("/providers/")) {
          return {
            ok: true,
            json: async () => ({ models: [] }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }));
    });

    it("submits true when checkbox is checked", async () => {
      const fetchMock = vi.mocked(fetch);
      const user = userEvent.setup();
      render(
        <NewTaskDialog
          repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", createdAt: "" }]}
          onClose={() => {}}
          onCreated={() => {}}
        />
      );

      await user.click(screen.getByLabelText("Title"));
      await user.keyboard("Test task");

      await user.click(screen.getByText("Advanced"));
      await user.click(screen.getByLabelText("Review plan before implementation"));
      await user.click(screen.getByText("Create task"));

      await waitFor(() => {
        const cardsCall = fetchMock.mock.calls.find(
          ([url]: unknown[]) => url === "/api/cards"
        );
        expect(cardsCall).toBeDefined();
        const body = JSON.parse((cardsCall as [string, RequestInit])[1].body as string);
        expect(body.reviewPlanBeforeImplementation).toBe(true);
      });
    });

    it("submits false when checkbox is left unchecked", async () => {
      const fetchMock = vi.mocked(fetch);
      const user = userEvent.setup();
      render(
        <NewTaskDialog
          repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", createdAt: "" }]}
          onClose={() => {}}
          onCreated={() => {}}
        />
      );

      await user.click(screen.getByLabelText("Title"));
      await user.keyboard("Test task");

      await user.click(screen.getByText("Create task"));

      await waitFor(() => {
        const cardsCall = fetchMock.mock.calls.find(
          ([url]: unknown[]) => url === "/api/cards"
        );
        expect(cardsCall).toBeDefined();
        const body = JSON.parse((cardsCall as [string, RequestInit])[1].body as string);
        expect(body.reviewPlanBeforeImplementation).toBe(false);
      });
    });
  });
});
