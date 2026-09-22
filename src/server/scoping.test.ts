import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const mocks = vi.hoisted(() => ({ runHarness: vi.fn() }));

vi.mock("./harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harness")>()),
  runHarness: mocks.runHarness,
}));
vi.mock("./settings", () => ({
  getSettings: () => ({
    scopingProvider: "openrouter",
    scopingModel: "scoping-model",
    scopingReasoningLevel: "high",
  }),
}));

const testDataDir = setupTestDataDir("radulf-scoping-");

const { db, cards, repos, scopingMessages, now } = await import("@/db");
const {
  addScopingMessage,
  listScopingMessages,
  parseScopedCardProposal,
  proposeScopedCard,
  renderScopingPrompt,
  scopingTurn,
} = await import("./scoping");

describe("renderScopingPrompt", () => {
  const card = { title: "Add rate limiting", description: "Login is brute-forceable." };

  it("carries the card, labels every speaker, and asks for the next message", () => {
    const prompt = renderScopingPrompt(card, [
      { role: "user", content: "Where should the limit live?" },
      { role: "assistant", content: "There is a loginRateLimit module." },
      { role: "planner", content: "1. Per IP or per account?" },
    ], "reply");

    expect(prompt).toContain("Title: Add rate limiting\n\nLogin is brute-forceable.");
    expect(prompt).toContain("Operator: Where should the limit live?");
    expect(prompt).toContain("You: There is a loginRateLimit module.");
    expect(prompt).toContain("Planner: 1. Per IP or per account?");
    expect(prompt).toMatch(/Write your next message to the operator\.$/);
    expect(prompt).not.toContain("TITLE:");
  });

  it("says when the thread is empty and asks for the scoped card in the fixed format", () => {
    const prompt = renderScopingPrompt({ ...card, description: "" }, [], "proposal");

    expect(prompt).toContain("(no description yet)");
    expect(prompt).toContain("(nothing yet)");
    expect(prompt).toContain("TITLE: <one line");
    expect(prompt).toContain("DESCRIPTION:\n");
    expect(prompt).toContain("## Acceptance criteria");
  });
});

describe("parseScopedCardProposal", () => {
  it("splits the fixed format into title and description", () => {
    const parsed = parseScopedCardProposal(
      "TITLE: Rate-limit login attempts per account\nDESCRIPTION:\n## Problem\nBrute force.\n",
      "old title",
    );
    expect(parsed).toEqual({
      title: "Rate-limit login attempts per account",
      description: "## Problem\nBrute force.",
    });
  });

  it("keeps the card's title when the reply has none, and takes a marker-less reply whole", () => {
    expect(parseScopedCardProposal("DESCRIPTION:\nJust a body.", "Keep me")).toEqual({
      title: "Keep me",
      description: "Just a body.",
    });
    expect(parseScopedCardProposal("TITLE: New\nNo marker here.", "old")).toEqual({
      title: "New",
      description: "No marker here.",
    });
  });

  it("unwraps a reply the model put in one code fence", () => {
    const parsed = parseScopedCardProposal(
      "```markdown\nTITLE: Fenced\nDESCRIPTION:\n- [ ] done\n```",
      "old",
    );
    expect(parsed).toEqual({ title: "Fenced", description: "- [ ] done" });
  });
});

describe("the scoping thread", () => {
  const repoPath = path.join(testDataDir, "repo");

  beforeEach(() => {
    mocks.runHarness.mockReset();
    db.delete(cards).run();
    db.delete(repos).run();
    db.insert(repos).values({ id: "r1", name: "repo", path: repoPath, defaultBranch: "main", createdAt: now() }).run();
    db.insert(cards).values({
      id: "c1", repoId: "r1", title: "Rough ask", description: "Make login safer", createdAt: now(), updatedAt: now(),
    }).run();
  });

  const harnessReply = (lastText: string) => ({
    code: 0, timedOut: false, stalled: false, stuck: false, error: "", lastText,
  });

  it("lists messages oldest first and drops them with the card", () => {
    addScopingMessage("c1", "planner", "Which module?");
    addScopingMessage("c1", "user", "The session one.");
    expect(listScopingMessages("c1").map((m) => [m.role, m.content])).toEqual([
      ["planner", "Which module?"],
      ["user", "The session one."],
    ]);

    db.delete(cards).where(eq(cards.id, "c1")).run();
    expect(db.select().from(scopingMessages).all()).toHaveLength(0);
  });

  it("runs a turn read-only in the card's repository on the scoping role and records both sides", async () => {
    mocks.runHarness.mockResolvedValue(harnessReply("Which login path: password or OIDC?"));

    const thread = await scopingTurn("c1", "  I want to slow down brute force.  ");

    expect(thread.map((m) => [m.role, m.content])).toEqual([
      ["user", "I want to slow down brute force."],
      ["assistant", "Which login path: password or OIDC?"],
    ]);
    expect(mocks.runHarness).toHaveBeenCalledTimes(1);
    const opts = mocks.runHarness.mock.calls[0][0];
    expect(opts).toMatchObject({
      provider: "openrouter",
      model: "scoping-model",
      reasoningLevel: "high",
      cwd: repoPath,
      readOnly: true,
    });
    expect(opts.role).toBeUndefined();
    expect(opts.prompt).toContain("Operator: I want to slow down brute force.");
    expect(opts.transcriptPath).toContain(path.join("transcripts", "scoping-c1-"));
  });

  it("runs one turn per card at a time, so a burst of posts cannot fan out into parallel sessions", async () => {
    let finish!: (value: ReturnType<typeof harnessReply>) => void;
    mocks.runHarness.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));

    const first = scopingTurn("c1", "first");
    await expect(scopingTurn("c1", "second")).rejects.toMatchObject({
      status: 409,
      message: "a scoping turn is already running for this card",
    });
    await expect(proposeScopedCard("c1")).rejects.toMatchObject({ status: 409 });
    // Recording an answer without a reply starts no session, so it is not held.
    await scopingTurn("c1", "answer", { reply: false });

    finish(harnessReply("Reply to the first."));
    expect((await first).map((m) => m.content)).toEqual(["first", "answer", "Reply to the first."]);
    expect(mocks.runHarness).toHaveBeenCalledTimes(1);

    // The turn released its claim on the way out.
    mocks.runHarness.mockResolvedValue(harnessReply("Reply to the third."));
    await expect(scopingTurn("c1", "third")).resolves.toBeDefined();
  });

  it("records an answer without a reply when asked, so the planner still sees it", async () => {
    const thread = await scopingTurn("c1", "Per account.", { reply: false });

    expect(thread.map((m) => m.role)).toEqual(["user"]);
    expect(mocks.runHarness).not.toHaveBeenCalled();
  });

  it("rejects an empty message and surfaces a harness error without recording a reply", async () => {
    await expect(scopingTurn("c1", "   ")).rejects.toThrow(/content is required/);

    mocks.runHarness.mockResolvedValue({ ...harnessReply(""), code: 1, error: "provider down" });
    await expect(scopingTurn("c1", "hello")).rejects.toThrow(/provider down/);
    expect(listScopingMessages("c1").map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps the proposal in the thread and returns it split into card fields", async () => {
    addScopingMessage("c1", "user", "Per account, five attempts.");
    mocks.runHarness.mockResolvedValue(
      harnessReply("TITLE: Lock login after five failed attempts per account\nDESCRIPTION:\n## Problem\nBrute force."),
    );

    const proposal = await proposeScopedCard("c1");

    expect(proposal.title).toBe("Lock login after five failed attempts per account");
    expect(proposal.description).toBe("## Problem\nBrute force.");
    expect(proposal.messages.at(-1)).toMatchObject({ role: "assistant", content: expect.stringContaining("TITLE:") });
    expect(mocks.runHarness.mock.calls[0][0].prompt).toContain("Now write the scoped card.");
  });

  it("404s for a card that does not exist", async () => {
    await expect(scopingTurn("missing", "hi")).rejects.toThrow(/card not found/);
  });
});
