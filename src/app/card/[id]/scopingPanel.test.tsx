// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScopingPanel } from "./scopingPanel";
import type { ScopingMessage } from "./useCardDetail";

const thread: ScopingMessage[] = [
  { id: 1, role: "planner", content: "1. Per IP or per account?", createdAt: "" },
  { id: 2, role: "user", content: "Per account.", createdAt: "" },
  { id: 3, role: "assistant", content: "Settled:\n\n- five attempts\n- `loginRateLimit.ts`", createdAt: "" },
];

let calls: { url: string; init?: RequestInit }[];

beforeEach(() => {
  cleanup();
  calls = [];
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = url.endsWith("/scoping/proposal")
      ? { title: "Lock login after five failures", description: "## Problem\nBrute force.", messages: [] }
      : { messages: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as unknown as typeof fetch;
});

const json = (index: number) => JSON.parse(String(calls[index].init?.body));

describe("ScopingPanel", () => {
  it("shows every speaker, labelling the planner's questions, and renders assistant Markdown", () => {
    render(<ScopingPanel cardId="c1" status="needs_attention" messages={thread} onChanged={() => {}} />);

    expect(screen.getByText("Planner asked")).toBeTruthy();
    // The planner's numbered questions render as a list, like any Markdown.
    expect(screen.getByText("Per IP or per account?").tagName).toBe("LI");
    expect(screen.getByText("Per account.")).toBeTruthy();
    expect(screen.getByText("Scoping assistant")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toContain("five attempts");
    expect(screen.getByText("loginRateLimit.ts").tagName).toBe("CODE");
  });

  it("sends a message and refreshes the card", async () => {
    const onChanged = vi.fn();
    render(<ScopingPanel cardId="c1" status="backlog" messages={[]} onChanged={onChanged} />);

    const input = screen.getByLabelText("Your message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "  What would this touch?  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls[0].url).toBe("/api/cards/c1/scoping");
    expect(json(0)).toEqual({ content: "What would this touch?" });
    expect(input.value).toBe("");
  });

  it("answers the planner without a reply and starts planning again", async () => {
    const onChanged = vi.fn();
    render(<ScopingPanel cardId="c1" status="needs_attention" messages={thread.slice(0, 1)} onChanged={onChanged} />);

    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "Per account." } });
    fireEvent.click(screen.getByRole("button", { name: "Answer and plan again" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.map((c) => c.url)).toEqual(["/api/cards/c1/scoping", "/api/cards/c1/restart"]);
    expect(json(0)).toEqual({ content: "Per account.", reply: false });
  });

  it("labels a blocker the loop reported and offers to answer and plan again", () => {
    render(<ScopingPanel cardId="c1" status="needs_attention" messages={[
      { id: 1, role: "loop", content: "No Atlassian session in the sandbox.", createdAt: "" },
    ]} onChanged={() => {}} />);

    expect(screen.getByText("Loop blocked")).toBeTruthy();
    expect(screen.getByText("No Atlassian session in the sandbox.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Answer and plan again" })).toBeTruthy();
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).placeholder).toMatch(/what the loop was missing/);
  });

  it("does not offer to plan again unless the planner asked", () => {
    render(<ScopingPanel cardId="c1" status="backlog" messages={thread.slice(1)} onChanged={() => {}} />);
    expect(screen.queryByRole("button", { name: "Answer and plan again" })).toBeNull();
  });

  it("drafts the scoped task into editable fields and applies them to the card", async () => {
    const onChanged = vi.fn();
    render(<ScopingPanel cardId="c1" status="todo" messages={thread} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "Draft the scoped task" }));

    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(title.value).toBe("Lock login after five failures");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("## Problem\nBrute force.");
    // The composer steps aside while a proposal is open.
    expect(screen.queryByLabelText("Your message")).toBeNull();

    fireEvent.change(title, { target: { value: "Lock login after five failed attempts" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to task" }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].url).toBe("/api/cards/c1");
    expect(calls[1].init?.method).toBe("PATCH");
    expect(json(1)).toEqual({ title: "Lock login after five failed attempts", description: "## Problem\nBrute force." });
    await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
    expect(screen.getByLabelText("Your message")).toBeTruthy();
  });

  it("is read-only once the card is running, and absent when there is nothing to show", () => {
    render(<ScopingPanel cardId="c1" status="looping" messages={thread} onChanged={() => {}} />);
    expect(screen.getByText("Per account.")).toBeTruthy();
    expect(screen.queryByLabelText("Your message")).toBeNull();
    cleanup();

    const { container } = render(<ScopingPanel cardId="c1" status="looping" messages={[]} onChanged={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("surfaces a failed turn without losing the draft", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "the scoping session timed out" }), { status: 500 })),
    ) as unknown as typeof fetch;
    render(<ScopingPanel cardId="c1" status="backlog" messages={[]} onChanged={() => {}} />);

    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toContain("the scoping session timed out");
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("hello");
  });
});
