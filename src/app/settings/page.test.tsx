// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SettingsPage from "./page";
import type { Settings } from "./useSettingsData";
import type { Repo } from "../ui/api";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));

const initialSettings: Settings = {
  plannerProvider: "anthropic", plannerModel: "planner", plannerReasoningLevel: "medium",
  loopProvider: "anthropic", loopModel: "looper", loopReasoningLevel: "medium",
  evaluatorProvider: "anthropic", evaluatorModel: "reviewer", evaluatorReasoningLevel: "high",
  plannerTimeoutMinutes: 30, defaultMaxIterations: 50, defaultTimeoutMinutes: 60,
  iterationHardTimeoutMinutes: 10, evaluatorTimeoutMinutes: 10, stallTimeoutSeconds: 300,
  omlxBaseUrl: "http://127.0.0.1:8000", omlxApiKey: "", openrouterApiKey: "••••••••", braveApiKey: "",
  minimalToolset: false, sandboxEnabled: true, sandboxNetworkAllowlist: "",
  sandboxWeakerIsolationForGoTls: false, notificationsEnabled: false, soundEnabled: false,
  theme: "default", plannerPromptTemplate: "Plan {{TITLE}}", evaluatorPromptTemplate: "Review {{CRITERIA}}",
  improvePromptTemplate: "Improve {{FOCUS}}",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function section(name: string) {
  fireEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("link", { name }));
}

describe("SettingsPage", () => {
  let savedSettings: Settings;
  let repositories: Repo[];
  let patch: (settings: Settings) => Response | Promise<Response>;

  beforeEach(() => {
    window.history.replaceState(null, "", "/settings");
    vi.stubGlobal("scrollTo", vi.fn());
    savedSettings = { ...initialSettings };
    repositories = [];
    patch = (settings) => {
      savedSettings = { ...settings, openrouterApiKey: settings.openrouterApiKey ? "••••••••" : "" };
      return json(savedSettings);
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings") {
        return init?.method === "PATCH" ? patch(JSON.parse(String(init.body))) : json(savedSettings);
      }
      if (url === "/api/repos") {
        if (init?.method === "POST") {
          repositories = [{ id: "new-repo", createdAt: "2026-09-12", ...JSON.parse(String(init.body)) }];
          return json(repositories[0], 201);
        }
        return json(repositories);
      }
      if (url.startsWith("/api/repos/") && init?.method === "DELETE") {
        return json({ error: "cannot remove a repository while one of its tasks is running or merging" }, 409);
      }
      if (url.startsWith("/api/providers/usage")) {
        return json({
          windowHours: 24,
          providers: [
            { provider: "anthropic", runs: 4, failedRuns: 0, promptTokens: 120_000, completionTokens: 3_000, costUsd: 0, costReported: false, lastRunAt: "2026-09-20T11:00:00.000Z", breaker: { provider: "anthropic", state: "open", reason: "limit", consecutiveFailures: 1, openedAt: "2026-09-20T11:30:00.000Z", openUntil: "2026-09-20T12:30:00.000Z" }, rateLimit: { provider: "anthropic", observedAt: "2026-09-20T11:30:00.000Z", status: "warning", windows: [{ label: "5h", utilization: 0.05, remaining: null, status: "ok", resetAt: null }, { label: "7d", utilization: 0.8, remaining: null, status: "warning", resetAt: null }], bindingWindow: "7d", resetAt: "2026-09-24T08:00:00.000Z", overageAvailable: false } },
            { provider: "omlx", runs: 2, failedRuns: 1, promptTokens: 2_000_000, completionTokens: 40_000, costUsd: 0, costReported: false, lastRunAt: "2026-09-20T11:50:00.000Z", breaker: { provider: "omlx", state: "closed", reason: null, consecutiveFailures: 0, openedAt: null, openUntil: null }, rateLimit: null },
          ],
        });
      }
      if (url.startsWith("/api/providers/")) return json({
        models: [
          { value: "planner", displayName: "Planning model", description: "A planning model" },
          { value: "looper", displayName: "Loop model", description: "A loop model" },
        ]
      });
      if (url.startsWith("/api/github/status")) return json({ ok: true, account: "test-user", reason: null, detail: null });
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
  });

  it("preserves edits across sections and repository changes, then saves them together", async () => {
    render(<SettingsPage />);
    await screen.findByRole("heading", { name: "General", level: 2 });
    expect(screen.queryByRole("heading", { name: "Planner agent" })).toBeNull();
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Nord" }));

    section("Agents & models");
    const planner = within(screen.getByRole("region", { name: "Planner agent" }));
    fireEvent.change(planner.getByLabelText("Model", { exact: true }), { target: { value: "custom/planner" } });
    section("Repositories");
    fireEvent.change(screen.getByLabelText("Repository name"), { target: { value: "My repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Type the path instead" }));
    fireEvent.change(screen.getByLabelText("Repository folder"), { target: { value: "/tmp/my-repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    await screen.findByText("My repo");

    section("General");
    expect((screen.getByRole("radio", { name: "Nord" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Settings saved ✓");
    expect(savedSettings).toMatchObject({ theme: "nord", plannerModel: "custom/planner" });
    expect(document.documentElement.dataset.theme).toBe("nord");
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a repository removal conflict on that repository's row", async () => {
    repositories = [
      { id: "busy-repo", name: "Busy repo", path: "/tmp/busy", defaultBranch: "main", createdAt: "2026-09-12" },
    ];
    vi.stubGlobal("confirm", vi.fn(() => true));
    window.history.replaceState(null, "", "/settings#repos");
    render(<SettingsPage />);
    await screen.findByText("Busy repo");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "cannot remove a repository while one of its tasks is running or merging",
    );
    expect(screen.getByText("Busy repo")).toBeTruthy();
  });

  it("opens existing deep links and responds to browser history", async () => {
    window.history.replaceState(null, "", "/settings#github");
    render(<SettingsPage />);
    await screen.findByRole("heading", { name: "Repositories", level: 2 });
    expect(screen.getByRole("heading", { name: "GitHub connection" })).toBeTruthy();
    section("Sandbox");
    expect(window.location.hash).toBe("#sandbox");
    expect(screen.getByRole("checkbox", { name: "Sandbox enabled" })).toBeTruthy();

    window.history.replaceState(null, "", "/settings#evaluator-defaults");
    fireEvent.popState(window);
    expect(screen.getByRole("heading", { name: "Run limits", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Evaluation" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Sandbox enabled" })).toBeNull();

    window.history.replaceState(null, "", "/settings#notifications");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(screen.getByRole("checkbox", { name: "Desktop notifications" })).toBeTruthy();

    window.history.replaceState(null, "", "/settings#constructor");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(screen.getByRole("heading", { name: "General", level: 2 })).toBeTruthy();
  });

  it("keeps a failed save editable and clears the dirty state after retrying", async () => {
    render(<SettingsPage />);
    await screen.findByRole("heading", { name: "General", level: 2 });
    section("Providers & keys");
    fireEvent.change(screen.getByLabelText("OpenRouter API key"), { target: { value: "new-key" } });
    const successfulPatch = patch;
    patch = () => json({ error: "Could not save settings" }, 500);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not save settings");
    expect((screen.getByLabelText("OpenRouter API key") as HTMLInputElement).value).toBe("new-key");

    patch = successfulPatch;
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Settings saved ✓");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("OpenRouter API key") as HTMLInputElement).value).toBe("••••••••");
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps edits made while a save is in flight", async () => {
    let finishSave!: (response: Response) => void;
    patch = () => new Promise((resolve) => { finishSave = resolve; });
    render(<SettingsPage />);
    await screen.findByRole("heading", { name: "General", level: 2 });
    section("Providers & keys");
    fireEvent.change(screen.getByLabelText("OpenRouter API key"), { target: { value: "replacement-key" } });
    section("General");
    fireEvent.click(screen.getByRole("radio", { name: "Nord" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Desktop notifications" }));
    finishSave(json({ ...initialSettings, theme: "nord" }));
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());
    expect((screen.getByRole("checkbox", { name: "Desktop notifications" }) as HTMLInputElement).checked).toBe(true);
    section("Providers & keys");
    expect((screen.getByLabelText("OpenRouter API key") as HTMLInputElement).value).toBe("••••••••");
  });

  it("flags a role whose provider does not suit it, and applies the suggested split", async () => {
    savedSettings = { ...initialSettings, plannerProvider: "omlx", plannerModel: "llm", evaluatorProvider: "omlx", evaluatorModel: "llm" };
    render(<SettingsPage />);
    await screen.findByRole("heading", { name: "General", level: 2 });
    section("Agents & models");

    // The planner and evaluator are on the self-hosted endpoint, the looper on
    // a subscription, so every role is off the split and all three are named.
    const summary = screen.getByRole("region", { name: "Suggested model split" });
    expect(summary.textContent).toContain("Planner agent");
    expect(summary.textContent).toContain("Looper agent");
    expect(summary.textContent).toContain("Evaluator agent");
    expect(screen.getByText(/Planning is the pipeline's hardest reasoning/)).toBeTruthy();
    expect(screen.getByText(/only gate that runs the whole-card acceptance criteria/)).toBeTruthy();
    expect(screen.getByText(/drives most of your token spend/)).toBeTruthy();

    fireEvent.click(within(summary).getByRole("button", { name: /Use Claude for planning and review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(savedSettings.plannerProvider).toBe("anthropic"));
    expect(savedSettings.evaluatorProvider).toBe("anthropic");
    expect(savedSettings.loopProvider).toBe("omlx");
    // The callout goes quiet once every role suits its stage.
    expect(screen.queryByRole("region", { name: "Suggested model split" })).toBeNull();
  });

  it("names a provider that is out of allowance, and what it has spent", async () => {
    render(<SettingsPage />);
    await screen.findByRole("heading", { name: "General", level: 2 });
    section("Providers & keys");
    const panel = await screen.findByRole("region", { name: "Provider usage and health" });
    await waitFor(() => expect(panel.textContent).toContain("Usage limit reached"));
    // The self-hosted endpoint is healthy, so it reports usage without a warning.
    expect(panel.textContent).toContain("2.0M in");
    expect(panel.textContent).toContain("1 failed");
    // Flat-rate providers report no cost, so no misleading $0.00 is shown.
    expect(panel.textContent).not.toContain("$0.00");
  });

  it("shows live allowance from the provider's own headers", async () => {
    render(<SettingsPage />);
    await screen.findByRole("heading", { name: "General", level: 2 });
    section("Providers & keys");
    const panel = await screen.findByRole("region", { name: "Provider usage and health" });
    await waitFor(() => expect(panel.textContent).toContain("7d 80% used"));
    expect(panel.textContent).toContain("5h 5% used");
    expect(panel.textContent).toContain("7d is binding");
    // No paid overflow past the limit is worth saying out loud.
    expect(panel.textContent).toContain("no overage");
    expect(panel.textContent).toContain("Approaching the allowance");
  });

  it("does not nag when every role already suits its stage", async () => {
    savedSettings = { ...initialSettings, loopProvider: "omlx", loopModel: "llm" };
    render(<SettingsPage />);
    await screen.findByRole("heading", { name: "General", level: 2 });
    section("Agents & models");
    expect(screen.queryByRole("region", { name: "Suggested model split" })).toBeNull();
  });
});
