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

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => {
  push.mockClear();
  vi.stubGlobal("confirm", () => false);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    json: async () => {
      const target = String(url);
      if (target.includes("/providers/")) return { models: [] };
      if (target.includes("/api/folder-browser")) {
        return {
          root: "/home/dev", path: "/home/dev", parent: null, truncated: false,
          entries: [
            { name: "a-repo", path: "/home/dev/a-repo", isGitRepo: true },
            { name: "notes", path: "/home/dev/notes", isGitRepo: false },
          ],
        };
      }
      if (target === "/api/cards" && init?.method === "POST") return { id: "card-1" };
      if (target.startsWith("/api/jira/issue")) {
        return { key: "DEV-123", url: "https://jira.example/browse/DEV-123", title: "[DEV-123] Fix the widget", description: "Jira: https://jira.example/browse/DEV-123\n\nIt is broken." };
      }
      if (target === "/api/repos/init") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { parentPath: string; name: string };
        return { id: "made-repo", name: body.name, path: `${body.parentPath}/${body.name}`, defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" };
      }
      if (target === "/api/repos/clone") {
        return { id: "cloned-repo", name: "repo", path: "/var/lib/radulf/repos/repo", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" };
      }
      if (target.includes("/api/repos") && init?.method !== "GET") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name: string; path: string };
        return { id: "new-repo", name: body.name, path: body.path, defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" };
      }
      return { plannerProvider: "p", loopProvider: "l", evaluatorProvider: "e" };
    },
  }))) as unknown as typeof fetch;
});

describe("NewTaskDialog", () => {
  it("registers a repository browsed from inside the dialog and selects it", async () => {
    const user = userEvent.setup();
    render(<NewTaskDialog repos={[]} onClose={() => {}} onCreated={() => {}} />);

    // With no repositories the browser opens straight away, rather than
    // sending the user to Settings and back.
    const folders = await screen.findByRole("list", { name: "Folders" });
    expect(folders.textContent).toContain("a-repo");
    // Only a git repository offers Select; a plain folder is navigation only.
    expect(screen.getAllByRole("button", { name: "Select" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Select" }));

    const repoSelect = await screen.findByLabelText("Repository");
    await waitFor(() => expect((repoSelect as HTMLSelectElement).value).toBe("new-repo"));
    expect(repoSelect.textContent).toContain("a-repo");
    cleanup();
  });

  it("prefills the title and description from a Jira issue", async () => {
    const user = userEvent.setup();
    render(
      <NewTaskDialog
        repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" }]}
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );

    await user.type(screen.getByLabelText("Import from Jira"), "https://jira.example/browse/DEV-123");
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("[DEV-123] Fix the widget"));
    expect((screen.getByLabelText("Description and definition of done") as HTMLTextAreaElement).value)
      .toBe("Jira: https://jira.example/browse/DEV-123\n\nIt is broken.");
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string][];
    expect(calls.some(([url]) => url === `/api/jira/issue?ref=${encodeURIComponent("https://jira.example/browse/DEV-123")}`)).toBe(true);
    cleanup();
  });

  it("creates a fresh repository inside the browsed folder and selects it", async () => {
    const user = userEvent.setup();
    render(<NewTaskDialog repos={[]} onClose={() => {}} onCreated={() => {}} />);
    await screen.findByRole("list", { name: "Folders" });

    await user.type(screen.getByLabelText("New repository name"), "fresh-project");
    await user.click(screen.getByRole("button", { name: "Create here" }));

    const repoSelect = await screen.findByLabelText("Repository");
    await waitFor(() => expect((repoSelect as HTMLSelectElement).value).toBe("made-repo"));
    expect(repoSelect.textContent).toContain("fresh-project");
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    const initCall = calls.find(([url]) => url === "/api/repos/init");
    expect(JSON.parse(String(initCall?.[1].body))).toEqual({ parentPath: "/home/dev", name: "fresh-project" });
    cleanup();
  });

  it("clones a repository from a URL and selects it", async () => {
    const user = userEvent.setup();
    render(<NewTaskDialog repos={[]} onClose={() => {}} onCreated={() => {}} />);
    await screen.findByRole("list", { name: "Folders" });

    await user.type(screen.getByLabelText("Repository URL"), "https://example.com/acme/repo.git");
    await user.click(screen.getByRole("button", { name: "Clone" }));

    const repoSelect = await screen.findByLabelText("Repository");
    await waitFor(() => expect((repoSelect as HTMLSelectElement).value).toBe("cloned-repo"));
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    const cloneCall = calls.find(([url]) => url === "/api/repos/clone");
    expect(JSON.parse(String(cloneCall?.[1].body))).toEqual({ url: "https://example.com/acme/repo.git" });
    cleanup();
  });

  it("offers browsing from the repository select when repositories exist", async () => {
    const user = userEvent.setup();
    render(
      <NewTaskDialog
        repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" }]}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );
    expect(screen.queryByRole("list", { name: "Folders" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Repository"), "__add__");
    expect(await screen.findByRole("list", { name: "Folders" })).toBeTruthy();
    cleanup();
  });

  it("keeps focus in the Title input while typing", async () => {
    const user = userEvent.setup();
    render(
      <NewTaskDialog
        repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" }]}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    await user.click(title);
    await user.keyboard("a");
    expect(document.activeElement).toBe(title);
  });

  it("opens the task for scoping from Create and scope, for a breakdown from Create and break down, and not from Create task", async () => {
    cleanup();
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <NewTaskDialog
        repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" }]}
        onClose={() => {}}
        onCreated={onCreated}
      />
    );
    await user.type(screen.getByLabelText("Title"), "Rough ask");
    await user.click(screen.getByRole("button", { name: "Create and scope" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(push).toHaveBeenCalledWith("/card/card-1");
    // The old planner chat is gone from Advanced.
    expect(screen.queryByText(/planner chat/i)).toBeNull();
    cleanup();

    render(
      <NewTaskDialog
        repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" }]}
        onClose={() => {}}
        onCreated={onCreated}
      />
    );
    await user.type(screen.getByLabelText("Title"), "Full ask");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2));
    expect(push).toHaveBeenCalledTimes(1);
    cleanup();

    render(
      <NewTaskDialog
        repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" }]}
        onClose={() => {}}
        onCreated={onCreated}
      />
    );
    await user.type(screen.getByLabelText("Title"), "Big ask");
    await user.click(screen.getByRole("button", { name: "Create and break down" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(3));
    expect(push).toHaveBeenLastCalledWith("/card/card-1?breakdown=propose");
    cleanup();
  });

  it("defaults to the scoped repo when defaultRepoId is provided", async () => {
    cleanup();
    const radulf = { id: "radulf", name: "radulf", path: "/r/radulf", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" };
    const doomClone = { id: "doom", name: "doom-clone", path: "/r/doom", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" };
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
          repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" }]}
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
        repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" }]}
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
        grillMe: false,
        scopingAuthorsPlan: false,
        autoApprove: false,
        openPr: false,
        baseBranch: null,
      });
    });
  });

  // Spec 15: the PR checkbox is only offerable when `gh` is installed and
  // authenticated AND the selected repo has an `origin`. Each of the three
  // failures names a different next action, so each is asserted separately.
  describe("Open a pull request instead of merging", () => {
    const repo = { id: "r", name: "Repo", path: "/r", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" };

    function stubGithubStatus(status: Record<string, unknown>) {
      cleanup();
      vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          const u = String(url);
          if (u.includes("/api/github/status")) return status;
          if (u.includes("/providers/")) return { models: [] };
          if (u.includes("/branches")) return [];
          return { plannerProvider: "p", loopProvider: "l", evaluatorProvider: "e" };
        },
      }))) as unknown as typeof fetch;
    }

    const openAdvanced = async () => {
      const user = userEvent.setup();
      render(<NewTaskDialog repos={[repo]} onClose={() => {}} onCreated={() => {}} />);
      await user.click(screen.getByText("Advanced"));
      return screen.getByLabelText("Open a pull request instead of merging") as HTMLInputElement;
    };

    it("is enabled when gh is ready and the repo has an origin", async () => {
      stubGithubStatus({ ok: true, reason: null, detail: null, hasRemote: true });
      const box = await openAdvanced();
      await waitFor(() => expect(box.disabled).toBe(false));
      expect(screen.queryByText(/no `origin` remote/)).toBeNull();
    });

    it.each([
      ["the remote, when the repo has no origin", { ok: true, reason: null, detail: null, hasRemote: false }, /no `origin` remote/],
      [
        "the login, when gh is not authenticated",
        { ok: false, reason: "unauthenticated", detail: "`gh` is not authenticated — run `gh auth login` in a terminal", hasRemote: true },
        /gh auth login/,
      ],
      [
        "the install, when gh is missing",
        { ok: false, reason: "missing", detail: "the GitHub CLI (`gh`) is not installed, not on PATH, or not executable", hasRemote: true },
        /not installed, not on PATH, or not executable/,
      ],
    ])("is disabled, naming %s", async (_label, status, reason) => {
      stubGithubStatus(status);
      const box = await openAdvanced();
      // Await the reason, not the disabled flag: the box is disabled before the
      // probe resolves, so asserting `disabled` alone would pass even if the
      // response were ignored entirely.
      expect(await screen.findByText(reason)).toBeTruthy();
      expect(box.disabled).toBe(true);
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

    it("submits true when checked (the full-payload test covers the false default)", async () => {
      const fetchMock = vi.mocked(fetch);
      const user = userEvent.setup();
      render(
        <NewTaskDialog
          repos={[{ id: "r", name: "Repo", path: "/r", defaultBranch: "main", approvedInstallScripts: "[]", createdAt: "" }]}
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
  });
});
