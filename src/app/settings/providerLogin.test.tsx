// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProviderLoginSection } from "./providerLogin";

const PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    oauth: { name: "Anthropic (Claude Pro/Max)", label: null, subscription: true },
    apiKey: { name: "Anthropic API key" },
    connected: null,
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    oauth: { name: "GitHub Copilot", label: null, subscription: true },
    apiKey: { name: "GitHub Copilot token" },
    connected: { type: "oauth", source: "OAuth" },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    oauth: { name: "OpenRouter OAuth", label: "Sign in with OpenRouter", subscription: false },
    apiKey: { name: "OpenRouter API key" },
    connected: null,
  },
];

let calls: { url: string; init?: RequestInit }[];
/** What GET /api/provider-login/:id answers with, replaced per test. */
let loginState: Record<string, unknown>;

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "/api/provider-login" && (!init || init.method === undefined)) return ok(PROVIDERS);
    if (url === "/api/provider-login") return ok(loginState); // POST: start or logout
    return ok(loginState); // the session routes
  }));
}

beforeEach(() => {
  cleanup();
  calls = [];
  loginState = { id: "s1", providerId: "anthropic", status: "waiting", events: [], prompt: null, error: null };
  stubFetch();
  vi.stubGlobal("confirm", () => true);
});

const body = (index: number) => JSON.parse(String(calls[index].init?.body));

/** Two subscription providers both render "Sign in", so scope to the row. */
async function clickIn(provider: string, button: string) {
  const row = (await screen.findByText(provider)).closest("li") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: button }));
}

describe("ProviderLoginSection", () => {
  it("shows connection status per provider and offers both methods", async () => {
    render(<ProviderLoginSection />);

    expect(await screen.findByText("Anthropic")).toBeTruthy();
    expect(screen.getByText(/connected · OAuth/)).toBeTruthy();
    expect(screen.getAllByText("not connected")).toHaveLength(1); // only Anthropic, of the subscriptions
    const anthropic = (await screen.findByText("Anthropic")).closest("li") as HTMLElement;
    expect(within(anthropic).getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(within(anthropic).getByRole("button", { name: "Enter a key" })).toBeTruthy();
    // Only the connected one offers a disconnect.
    expect(within(anthropic).queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("keeps the non-subscription providers behind a disclosure", async () => {
    render(<ProviderLoginSection />);

    // OpenRouter is not a subscription, so it is not in the first list.
    expect(await screen.findByRole("button", { name: "Show 1 more providers" })).toBeTruthy();
    expect(screen.queryByText("OpenRouter")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show 1 more providers" }));

    expect(screen.getByText("OpenRouter")).toBeTruthy();
    // And it uses the provider's own selector label when it has one.
    expect(screen.getByRole("button", { name: "Sign in with OpenRouter" })).toBeTruthy();
  });

  it("renders an auth_url and a pasted-code prompt, then submits the answer by token", async () => {
    loginState = {
      id: "s1",
      providerId: "anthropic",
      status: "prompting",
      events: [{ type: "auth_url", url: "https://example.test/auth?state=abc", instructions: "open it" }],
      prompt: { token: "t1", kind: "manual_code", message: "paste the code", placeholder: "http://localhost:53692" },
      error: null,
    };
    render(<ProviderLoginSection />);

    await clickIn("Anthropic", "Sign in");

    const link = (await screen.findByRole("link", { name: "Open this link to authorize" })) as HTMLAnchorElement;
    expect(link.href).toBe("https://example.test/auth?state=abc");
    expect(screen.getByText("open it")).toBeTruthy();
    // The paste box explains why the redirect page will have failed to load.
    expect(screen.getByText(/Paste either the authorization code or the whole URL/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("paste the code"), { target: { value: " the-code " } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/api/provider-login/s1")).toBe(true));
    const answer = calls.findIndex((c) => c.url === "/api/provider-login/s1");
    expect(body(answer)).toEqual({ token: "t1", value: " the-code " });
  });

  it("renders a device code with its verification URI", async () => {
    loginState = {
      id: "s1",
      providerId: "github-copilot",
      status: "waiting",
      events: [{ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" }],
      prompt: null,
      error: null,
    };
    render(<ProviderLoginSection />);

    await clickIn("GitHub Copilot", "Sign in");

    expect(await screen.findByText("ABCD-1234")).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://github.com/login/device" })).toBeTruthy();
    expect(screen.getByText(/Waiting for you to authorize/)).toBeTruthy();
    // Nothing to answer yet, so no input is offered.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("renders a select prompt as a picker", async () => {
    loginState = {
      id: "s1",
      providerId: "anthropic",
      status: "prompting",
      events: [],
      prompt: {
        token: "t1",
        kind: "select",
        message: "How do you want to sign in?",
        options: [{ id: "oauth", label: "Use a subscription" }, { id: "key", label: "Use an API key" }],
      },
      error: null,
    };
    render(<ProviderLoginSection />);

    await clickIn("Anthropic", "Sign in");

    const select = (await screen.findByLabelText("How do you want to sign in?")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "key" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/api/provider-login/s1")).toBe(true));
    expect(body(calls.findIndex((c) => c.url === "/api/provider-login/s1"))).toEqual({ token: "t1", value: "key" });
  });

  it("lets a text prompt be answered with nothing", async () => {
    loginState = {
      id: "s1",
      providerId: "github-copilot",
      status: "prompting",
      events: [],
      // pi's own wording: blank means github.com, so Continue has to be live
      // on an untouched field.
      prompt: { token: "t1", kind: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" },
      error: null,
    };
    render(<ProviderLoginSection />);

    await clickIn("GitHub Copilot", "Sign in");

    const submit = await screen.findByRole("button", { name: "Continue" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(calls.some((c) => c.url === "/api/provider-login/s1")).toBe(true));
    expect(body(calls.findIndex((c) => c.url === "/api/provider-login/s1"))).toEqual({ token: "t1", value: "" });
  });

  it("still requires a value for the other prompt kinds", async () => {
    loginState = {
      id: "s1",
      providerId: "anthropic",
      status: "prompting",
      events: [],
      prompt: { token: "t1", kind: "manual_code", message: "paste the code" },
      error: null,
    };
    render(<ProviderLoginSection />);

    await clickIn("Anthropic", "Sign in");

    const submit = await screen.findByRole("button", { name: "Continue" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("masks a secret prompt", async () => {
    loginState = {
      id: "s1",
      providerId: "anthropic",
      status: "prompting",
      events: [],
      prompt: { token: "t1", kind: "secret", message: "Anthropic API key" },
      error: null,
    };
    render(<ProviderLoginSection />);

    await clickIn("Anthropic", "Enter a key");

    expect(((await screen.findByLabelText("Anthropic API key")) as HTMLInputElement).type).toBe("password");
  });

  it("says when a login finished, and refreshes the list", async () => {
    loginState = {
      id: "s1",
      providerId: "anthropic",
      status: "done",
      events: [{ type: "progress", message: "Exchanging…" }],
      prompt: null,
      error: null,
    };
    render(<ProviderLoginSection />);

    await clickIn("Anthropic", "Sign in");

    expect(await screen.findByText(/Connected\. Agents can use anthropic now\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to providers" }));
    expect(await screen.findByText("Anthropic")).toBeTruthy();
  });

  it("surfaces why a login failed", async () => {
    loginState = {
      id: "s1",
      providerId: "anthropic",
      status: "failed",
      events: [],
      prompt: null,
      error: "OAuth state mismatch",
    };
    render(<ProviderLoginSection />);

    await clickIn("Anthropic", "Sign in");

    expect((await screen.findByRole("alert")).textContent).toContain("OAuth state mismatch");
  });

  it("disconnects a connected provider after confirming", async () => {
    render(<ProviderLoginSection />);

    await clickIn("GitHub Copilot", "Disconnect");

    await waitFor(() => expect(calls.some((c) => c.init?.method !== undefined)).toBe(true));
    const post = calls.findIndex((c) => c.init?.body !== undefined);
    expect(body(post)).toEqual({ providerId: "github-copilot", logout: true });
  });
});
