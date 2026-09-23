import fs from "node:fs";
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

const { db, cards, events, repos, scopingMessages, now } = await import("@/db");
const { bus } = await import("./events");
const {
  addScopingMessage,
  listScopingMessages,
  parseScopedCardProposal,
  proposeScopedCard,
  parsePlanProposal,
  parseSplitProposal,
  parseSplitRunMode,
  renderScopingPrompt,
  scopingTurn,
  scopingTurnInFlight,
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

  it("paces the interview conversationally unless the card asks to be grilled", () => {
    expect(renderScopingPrompt(card, [], "reply")).toContain("one to three high-value questions");

    const grilled = renderScopingPrompt({ ...card, grillMe: 1 }, [], "reply");

    // Upstream issue 33: the grilling protocol, not a few questions a turn.
    expect(grilled).not.toContain("one to three high-value questions");
    expect(grilled).toContain("DESIGN TREE");
    expect(grilled).toContain("FRONTIER");
    expect(grilled).toContain("**Q1**");
    // Still the same session: repo-grounded, and it still ends with a card.
    expect(grilled).toContain("read-only tools");
    expect(grilled).toContain("offer to write the scoped card");
  });
});

describe("parseSplitProposal", () => {
  it("splits the numbered blocks into ordered cards", () => {
    const cards = parseSplitProposal(
      [
        "CARD 1",
        "TITLE: Add the login rate limiter",
        "DESCRIPTION:",
        "## Problem",
        "Brute force. Does NOT touch the UI.",
        "",
        "CARD 2",
        "TITLE: Surface the lockout in the login form",
        "DESCRIPTION:",
        "## Problem",
        "Depends on card 1.",
      ].join("\n"),
      "Rate limiting",
    );

    expect(cards).toEqual([
      {
        title: "Add the login rate limiter",
        description: "## Problem\nBrute force. Does NOT touch the UI.",
      },
      {
        title: "Surface the lockout in the login form",
        description: "## Problem\nDepends on card 1.",
      },
    ]);
  });

  it("drops preamble, falls back per card on a missing title, and drops empty blocks", () => {
    const cards = parseSplitProposal(
      "Here is the split:\n\nCARD 1\nDESCRIPTION:\nFirst piece.\n\nCARD 2\n\nCARD 3\nTITLE: Third\nDESCRIPTION:\nThird piece.",
      "Rate limiting",
    );

    expect(cards).toEqual([
      { title: "Rate limiting (1)", description: "First piece." },
      { title: "Third", description: "Third piece." },
    ]);
    // The blank CARD 2 block is gone, so the fallback numbering follows the
    // cards that survived rather than the model's own numbering.
  });

  it("reads the run mode off the RUN line, defaulting to in order, and keeps the line out of the cards", () => {
    const reply = "RUN: in parallel\n\nCARD 1\nTITLE: A\nDESCRIPTION:\nx\n\nCARD 2\nTITLE: B\nDESCRIPTION:\ny";
    expect(parseSplitRunMode(reply)).toBe("parallel");
    expect(parseSplitRunMode("RUN: in order\n\nCARD 1\nTITLE: A")).toBe("ordered");
    expect(parseSplitRunMode("CARD 1\nTITLE: A")).toBe("ordered");
    expect(parseSplitProposal(reply, "f").map((c) => c.title)).toEqual(["A", "B"]);
  });

  it("returns nothing when the reply carries no card blocks at all", () => {
    expect(parseSplitProposal("I do not think this needs splitting.", "T")).toEqual([]);
  });
});

describe("parsePlanProposal", () => {
  const plan = "```PLAN.md\n# Rate limiting\n\n## Tasks\n\n- [ ] Add the bucket\n```";
  const prompt = "```PROMPT.md\nNext.js app. `make check` is the gate.\n```";
  const criteria = "```CRITERIA.md\n- [ ] `make test` exits 0\n```";
  const reply = [plan, prompt, criteria].join("\n\n");

  it("takes the three artifacts by filename, not by position", () => {
    const shuffled = [criteria, plan, prompt].join("\n\n");

    expect(parsePlanProposal(shuffled)).toEqual({
      planMd: "# Rate limiting\n\n## Tasks\n\n- [ ] Add the bucket",
      promptMd: "Next.js app. `make check` is the gate.",
      acceptanceCriteria: "- [ ] `make test` exits 0",
    });
  });

  it("reads the three in the order it was asked for too", () => {
    expect(parsePlanProposal(reply)?.promptMd).toBe("Next.js app. `make check` is the gate.");
  });

  it("refuses a partial answer, because there is no fallback prompt", () => {
    expect(parsePlanProposal([plan, criteria].join("\n\n"))).toBeNull();
    expect(parsePlanProposal("no fences at all")).toBeNull();
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

  it("reports the turn in flight, pushes its transcript under the card's scoping run id, and marks both ends", async () => {
    const pushes: { runId: string; lines: unknown[] }[] = [];
    const onPush = (push: { runId: string; lines: unknown[] }) => { pushes.push(push); };
    bus.on("transcript", onPush);
    let finish!: (value: ReturnType<typeof harnessReply>) => void;
    mocks.runHarness.mockImplementationOnce((opts: { transcriptPath: string }) => {
      // What the harness does once the model answers: create the file the
      // push is already watching for, and append to it. Delayed, as in a
      // real run, so the watcher's first look finds nothing there yet.
      setTimeout(() => {
        fs.mkdirSync(path.dirname(opts.transcriptPath), { recursive: true });
        fs.writeFileSync(opts.transcriptPath, `${JSON.stringify({ t: "tool", name: "read", input: { path: "src/a.ts" } })}\n`);
      }, 400);
      return new Promise((resolve) => { finish = resolve; });
    });
    const turn = scopingTurn("c1", "look around");
    try {
      await vi.waitFor(() => expect(scopingTurnInFlight("c1")).toMatchObject({ request: "reply" }));
      await vi.waitFor(() => expect(pushes.some((p) => p.runId === "scoping:c1")).toBe(true), { timeout: 4000 });
      expect(pushes.find((p) => p.runId === "scoping:c1")?.lines).toEqual([{ t: "tool", name: "read", input: { path: "src/a.ts" } }]);
    } finally {
      // Always let the turn finish, so a failure here cannot hold the card's
      // one turn slot and fail every test after it too.
      finish(harnessReply("Done looking."));
      await turn;
      bus.off("transcript", onPush);
    }
    expect(scopingTurnInFlight("c1")).toBeNull();
    expect(db.select().from(events).where(eq(events.cardId, "c1")).all().map((e) => [e.type, e.payload])).toEqual([
      ["scoping.started", JSON.stringify({ request: "reply" })],
      ["scoping.finished", JSON.stringify({ request: "reply" })],
    ]);
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
