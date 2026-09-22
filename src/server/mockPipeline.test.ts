import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The whole pipeline — planner → loop → evaluator → merge — driven by the
 * scripted mock provider (harness/mock.ts) instead of a model. Nothing is
 * mocked below the model: real orchestrator, real pi sessions and tools, real
 * worktrees and git, real DB. Each scenario is a card whose per-card models
 * name it.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-mock-pipeline-"));
// Worktrees, plans, and run scratch default to siblings of the data dir —
// nest it so they all land inside `root`.
process.env.RADULF_DATA_DIR = path.join(root, "data");
process.env.RADULF_MOCK_LLM = "1";
// No pi.dev model-catalog fetch: the mock needs no catalog.
process.env.PI_OFFLINE = "1";

const { db, cards, runs, plans, repos, events, now } = await import("@/db");
const { patchSettings, getSettings } = await import("./settings");
const { Orchestrator } = await import("./orchestrator");
const { runHarness } = await import("./harness");
const { listScopingMessages, proposeScopedCard, scopingTurn } = await import("./scoping");

const TERMINAL = new Set(["review", "needs_attention", "done", "plan_review"]);

let orch: InstanceType<typeof Orchestrator>;

beforeAll(() => {
  patchSettings({
    plannerProvider: "mock",
    loopProvider: "mock",
    evaluatorProvider: "mock",
    scopingProvider: "mock",
    plannerModel: "",
    loopModel: "",
    evaluatorModel: "",
    autoMode: false,
    // srt needs platform support CI may lack; containment has its own tests.
    sandboxEnabled: false,
  });
  orch = new Orchestrator({ autoStart: false });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A fresh repo per scenario, so no card waits on another's pipeline slot. */
function seedRepo(name: string) {
  const repoPath = path.join(root, "repos", name);
  fs.mkdirSync(repoPath, { recursive: true });
  gitIn(repoPath, "init", "-q", "-b", "main");
  gitIn(repoPath, "config", "user.name", "Mock Pipeline Test");
  gitIn(repoPath, "config", "user.email", "mock@radulf.local");
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  gitIn(repoPath, "add", ".");
  gitIn(repoPath, "commit", "-q", "-m", "initial");
  const id = `repo-${name}`;
  db.insert(repos).values({ id, name, path: repoPath, defaultBranch: "main", createdAt: now() }).run();
  return { id, repoPath };
}

/** Start a Todo card whose every role runs `scenario`; resolve once it rests. */
async function runScenario(scenario: string, repo = seedRepo(scenario)) {
  const cardId = `card-${scenario}`;
  db.insert(cards)
    .values({
      id: cardId,
      repoId: repo.id,
      title: `Mock ${scenario}`,
      description: "Driven by the mock provider.",
      status: "todo",
      position: 1,
      plannerModel: scenario,
      loopModel: scenario,
      evaluatorModel: scenario,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  orch.startCard(cardId);
  await waitFor(() => TERMINAL.has(cardStatus(cardId)) && !orch.hasInFlightWork());
  return { cardId, repo };
}

const cardStatus = (cardId: string) =>
  db.select().from(cards).where(eq(cards.id, cardId)).get()!.status;

const cardRuns = (cardId: string, kind?: "plan" | "loop" | "evaluate") =>
  db
    .select()
    .from(runs)
    .where(kind ? and(eq(runs.cardId, cardId), eq(runs.kind, kind)) : eq(runs.cardId, cardId))
    .orderBy(asc(runs.startedAt))
    .all();

async function waitFor(done: () => boolean, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the pipeline to settle");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("mock provider — full pipeline", () => {
  // happy-path merges into this repo; revise-once then runs on it, so its
  // main already holds the same task files and history that isn't its own.
  let shared: ReturnType<typeof seedRepo>;
  beforeAll(() => {
    shared = seedRepo("shared");
  });

  it("happy-path: plans, loops both tasks, gets approved, and merges", async () => {
    const { cardId, repo } = await runScenario("happy-path", shared);
    expect(cardStatus(cardId)).toBe("review");

    const [plan] = cardRuns(cardId, "plan");
    expect(plan).toMatchObject({ status: "completed", exitReason: "plan artifacts written", provider: "mock" });
    const [loop] = cardRuns(cardId, "loop");
    expect(loop).toMatchObject({ status: "completed", exitReason: "done-signal", iterationsDone: 2 });
    // Telemetry flowed through the real normalizer: token estimates, zero cost.
    expect(loop.promptTokens).toBeGreaterThan(0);
    expect(loop.toolCalls).toBeGreaterThan(0);
    expect(loop.costUsd).toBe(0);
    const [evaluation] = cardRuns(cardId, "evaluate");
    expect(evaluation).toMatchObject({ status: "completed", exitReason: "approve" });

    // The orchestrator, not the agent, committed each task.
    const log = gitIn(loop.worktreePath, "log", "--format=%s");
    expect(log).toContain("ralph: task 1 — Completed task 1: Create mock-output/task-1.md");
    expect(log).toContain("ralph: task 2 — Completed task 2: Create mock-output/task-2.md");
    expect(db.select().from(cards).where(eq(cards.id, cardId)).get()!.summary).toMatch(/^Mock run/);

    await orch.approve(loop.id);
    expect(cardStatus(cardId)).toBe("done");
    expect(gitIn(repo.repoPath, "show", "main:mock-output/task-2.md").split("\n")[0]).toBe(
      "Create mock-output/task-2.md",
    );
  }, 30_000);

  it("revise-once: a revise verdict re-plans, re-loops, then approves", async () => {
    const { cardId } = await runScenario("revise-once", shared);
    expect(cardStatus(cardId)).toBe("review");
    expect(cardRuns(cardId, "evaluate").map((r) => r.exitReason)).toEqual(["revise", "approve"]);
    expect(cardRuns(cardId, "plan")).toHaveLength(2);
    const replan = db.select().from(plans).where(and(eq(plans.cardId, cardId), eq(plans.version, 2))).get();
    expect(replan?.feedback).toContain("Mock revision");
  }, 30_000);

  it("planner-questions: parks the card for a human", async () => {
    const { cardId } = await runScenario("planner-questions");
    expect(cardStatus(cardId)).toBe("needs_attention");
    expect(cardRuns(cardId)).toEqual([
      expect.objectContaining({ kind: "plan", exitReason: "planner raised follow-up questions" }),
    ]);
  }, 30_000);

  it("loop-blocked: hands the card back with the blocker in its thread, and plans again around it", async () => {
    const { cardId } = await runScenario("loop-blocked");
    expect(cardStatus(cardId)).toBe("needs_attention");
    const [loop] = cardRuns(cardId, "loop");
    expect(loop).toMatchObject({ status: "failed", exitReason: "loop blocked", iterationsDone: 1 });
    expect(loop.feedback).toContain("Mock blocker");
    // The blocked task was not ticked, and the blocker is where the operator answers it.
    expect(listScopingMessages(cardId).map((m) => [m.role, m.content.split(":")[0]])).toEqual([["loop", "Mock blocker"]]);
    expect(
      db.select().from(events).where(eq(events.cardId, cardId)).all().filter((e) => e.type === "stage.misconfigured"),
    ).toHaveLength(0);

    // Plan again re-plans on top of the branch with the blocker as feedback,
    // rather than re-running the loop.
    orch.restartCard(cardId);
    await waitFor(() => TERMINAL.has(cardStatus(cardId)) && !orch.hasInFlightWork());
    expect(cardRuns(cardId, "plan")).toHaveLength(2);
    const replan = db.select().from(plans).where(and(eq(plans.cardId, cardId), eq(plans.version, 2))).get();
    expect(replan?.feedback).toContain("Mock blocker");
  }, 30_000);

  it("provider-error: the planner fails with the provider's message", async () => {
    const { cardId } = await runScenario("provider-error");
    expect(cardStatus(cardId)).toBe("needs_attention");
    expect(cardRuns(cardId, "plan")[0].exitReason).toBe(
      "planner failed: mock provider-error scenario: 400 invalid request",
    );
  }, 30_000);

  it("stuck: the stuck detector kills each iteration until the loop gives up", async () => {
    const { cardId } = await runScenario("stuck");
    expect(cardStatus(cardId)).toBe("needs_attention");
    const [loop] = cardRuns(cardId, "loop");
    expect(loop.iterationsDone).toBe(3);
    expect(loop.exitReason).toMatch(/^loop failed: harness repeated the same tool call/);
  }, 30_000);

  it("phantom: ITERATION_DONE without a work product stalls the loop", async () => {
    const { cardId } = await runScenario("phantom");
    expect(cardStatus(cardId)).toBe("needs_attention");
    expect(cardRuns(cardId, "loop")[0]).toMatchObject({ exitReason: "stalled", iterationsDone: 3 });
  }, 30_000);

  it("off-branch: an agent that checks out another branch fails the run before anything is committed", async () => {
    const { cardId, repo } = await runScenario("off-branch");
    expect(cardStatus(cardId)).toBe("needs_attention");
    const [loop] = cardRuns(cardId, "loop");
    expect(loop).toMatchObject({ status: "failed", iterationsDone: 1 });
    expect(loop.exitReason).toBe(`worktree left its run branch: on escaped, expected ${loop.branch}`);
    // The branch the agent switched to still sits where it was created: no
    // task commit followed the checkout, and the run branch is untouched.
    expect(gitIn(repo.repoPath, "rev-parse", "escaped")).toBe(gitIn(repo.repoPath, "rev-parse", loop.branch));
    expect(gitIn(repo.repoPath, "log", "--format=%s", "-1", loop.branch)).toBe("ralph: sync plan v1");
  }, 30_000);
});

describe("mock provider — outside the pipeline", () => {
  it("stall: the stall watchdog aborts a stream that never produces output", async () => {
    const cwd = fs.mkdtempSync(path.join(root, "stall-"));
    const result = await runHarness({
      provider: "mock",
      model: "stall",
      reasoningLevel: "off",
      prompt: "anything",
      cwd,
      transcriptPath: path.join(cwd, "t.jsonl"),
      timeoutMs: 10_000,
      stallTimeoutMs: 200,
      readOnly: true,
      settings: getSettings(),
    });
    expect(result).toMatchObject({ stalled: true, code: 1 });
  });

  it("scopes a card read-only against its own repository and proposes a card from the thread", async () => {
    const repo = seedRepo("scoping");
    db.insert(cards)
      .values({
        id: "card-scoping", repoId: repo.id, title: "Rough ask", description: "Do a thing.",
        status: "backlog", position: 1, createdAt: now(), updatedAt: now(),
      })
      .run();

    const thread = await scopingTurn("card-scoping", "What would this touch?");
    expect(thread.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(thread[1].content).toMatch(/^Mock reply/);

    // The mock's reply has no TITLE line, so the card keeps its title and the
    // whole reply becomes the description — and stays in the thread.
    const proposal = await proposeScopedCard("card-scoping");
    expect(proposal.title).toBe("Rough ask");
    expect(proposal.description).toMatch(/^Mock reply/);
    expect(proposal.messages).toHaveLength(3);
  }, 30_000);

  it("without RADULF_MOCK_LLM=1, refuses to run rather than fall back to a paid provider", async () => {
    process.env.RADULF_MOCK_LLM = "0";
    try {
      // The stored choice survives (getSettings drops invalid values to the
      // anthropic default)…
      expect(getSettings().plannerProvider).toBe("mock");
      // …and the run fails loudly instead of reaching a real model.
      await expect(scopingTurn("card-scoping", "hi")).rejects.toThrow(/mock provider is disabled/);
    } finally {
      process.env.RADULF_MOCK_LLM = "1";
    }
  });
});
