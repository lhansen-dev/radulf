import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const mocks = vi.hoisted(() => ({
  runHarness: vi.fn(),
  tryGit: vi.fn(),
  // The fixture worktree is not a real checkout; the guard would otherwise
  // report it as no longer sharing the repository's git dir.
  offRunBranchReason: vi.fn().mockResolvedValue(null),
}));

vi.mock("./harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harness")>()),
  runHarness: mocks.runHarness,
}));
vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  tryGit: mocks.tryGit,
  offRunBranchReason: mocks.offRunBranchReason,
}));
vi.mock("./settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings")>()),
  getSettings: () =>
    testSettings({
      criticModel: "critic-model",
      criticPromptTemplate: "Critique {{TITLE}}\n{{PLAN_MD}}\n.ralph/CRITIQUE.md",
      criticTimeoutMinutes: 7,
      sandboxEnabled: false,
    }),
}));

const testDataDir = setupTestDataDir("radulf-planCriticService-");
const { testSettings } = await import("@/testUtils/testSettings");
// Imported after setupTestDataDir, like everything else that reaches @/db.
const { db, cards, events, plans, repos, runs, now } = await import("@/db");
const {
  CRITIQUE_FILE,
  PlanCriticService,
  criticEnabled,
  namedSpecFiles,
  renderCriticPrompt,
  consecutiveCriticRevisions,
} = await import("./planCriticService");

describe("criticEnabled", () => {
  it("lets a per-card override beat the workspace mode either way", () => {
    expect(criticEnabled({ planCritic: 1, parentCardId: null }, { planCriticMode: "off" })).toBe(true);
    expect(criticEnabled({ planCritic: 0, parentCardId: "parent" }, { planCriticMode: "always" })).toBe(false);
  });

  it("falls back to the mode when the card has no override", () => {
    expect(criticEnabled({ planCritic: null, parentCardId: "parent" }, { planCriticMode: "breakdown" })).toBe(true);
    expect(criticEnabled({ planCritic: null, parentCardId: null }, { planCriticMode: "breakdown" })).toBe(false);
    expect(criticEnabled({ planCritic: null, parentCardId: null }, { planCriticMode: "always" })).toBe(true);
    expect(criticEnabled({ planCritic: null, parentCardId: "parent" }, { planCriticMode: "off" })).toBe(false);
  });
});

describe("namedSpecFiles", () => {
  it("returns each named spec once, in order of first appearance", () => {
    expect(
      namedSpecFiles("see specs/04-agent-pipeline.md and specs/17-task-scoping.md, specs/04-agent-pipeline.md again"),
    ).toEqual(["specs/04-agent-pipeline.md", "specs/17-task-scoping.md"]);
    expect(namedSpecFiles("nothing here", "")).toEqual([]);
  });
});

describe("renderCriticPrompt", () => {
  const template =
    "T={{TITLE}}\nD={{DESCRIPTION}}\n{{SCOPING_SECTION}}\nS={{SPEC_FILES}}\nV={{PLAN_VERSION}}\nP={{PLAN_MD}}\nC={{CRITERIA_MD}}\nR={{PROMPT_MD}}\n";

  it("fills every placeholder and always names the verdict file", () => {
    const rendered = renderCriticPrompt(template, {
      title: "Add critic",
      description: "Review plans",
      scoping: [
        { role: "user", content: "Keep it read-only." },
        { role: "planner", content: "1. Cap revisions?" },
      ],
      specFiles: ["specs/30-plan-critic.md", "specs/04-agent-pipeline.md"],
      planVersion: 3,
      planMd: "- [ ] task one",
      criteriaMd: "- it works",
      promptMd: "do the thing",
    });

    expect(rendered).toContain("T=Add critic");
    expect(rendered).toContain("D=Review plans");
    expect(rendered).toContain("SCOPING THREAD");
    expect(rendered).toContain("Operator: Keep it read-only.");
    expect(rendered).toContain("Planner (an earlier planning run): 1. Cap revisions?");
    expect(rendered).toContain("S=specs/30-plan-critic.md\nspecs/04-agent-pipeline.md");
    expect(rendered).toContain("V=3");
    expect(rendered).toContain("P=- [ ] task one");
    expect(rendered).toContain("C=- it works");
    expect(rendered).toContain("R=do the thing");
    expect(rendered).not.toContain("{{");
    expect(rendered).toContain(`.ralph/${CRITIQUE_FILE}`);
    expect(CRITIQUE_FILE).toBe("CRITIQUE.md");
  });

  it("uses fallbacks for an empty description, thread and spec list", () => {
    const rendered = renderCriticPrompt(template, {
      title: "Add critic",
      description: "",
      scoping: [],
      specFiles: [],
      planVersion: 1,
      planMd: "",
      criteriaMd: "",
      promptMd: "",
    });

    expect(rendered).toContain("D=(no description)");
    expect(rendered).not.toContain("SCOPING THREAD");
    expect(rendered).toContain("S=(the card names no spec files)");
    expect(rendered).toContain(".ralph/CRITIQUE.md");
  });

  it("does not repeat the verdict instruction when the template already has it", () => {
    const rendered = renderCriticPrompt("{{TITLE}}\nWrite to .ralph/CRITIQUE.md.", {
      title: "x",
      description: "",
      scoping: [],
      specFiles: [],
      planVersion: 1,
      planMd: "",
      criteriaMd: "",
      promptMd: "",
    });
    expect(rendered.match(/\.ralph\/CRITIQUE\.md/g)).toHaveLength(1);
  });
});

describe("consecutiveCriticRevisions", () => {
  function seedRun(id: string, cardId: string, kind: "loop" | "critique", startedAt: string, exitReason: string | null) {
    db.insert(runs)
      .values({
        id,
        cardId,
        kind,
        status: "completed",
        worktreePath: "/tmp/wt",
        branch: "ralph/x",
        exitReason,
        startedAt,
        endedAt: startedAt,
      })
      .run();
  }

  function seedCard(id: string) {
    db.insert(cards)
      .values({
        id,
        repoId: "repo-1",
        title: `Card ${id}`,
        description: "",
        status: "planning",
        baseBranch: "main",
        position: 1,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }

  it("counts critique revise runs since the latest loop run only", () => {
    db.insert(repos)
      .values({ id: "repo-1", name: "Repo", path: path.join(testDataDir, "repo"), defaultBranch: "main", createdAt: now() })
      .run();
    seedCard("card-a");
    seedCard("card-b");

    // card-a: an old revise before the loop, then two after; an approve in between.
    seedRun("r1", "card-a", "critique", "2024-01-01T00:00:00.000Z", "revise");
    seedRun("r2", "card-a", "loop", "2024-01-02T00:00:00.000Z", "done");
    seedRun("r3", "card-a", "critique", "2024-01-03T00:00:00.000Z", "revise");
    seedRun("r4", "card-a", "critique", "2024-01-04T00:00:00.000Z", "approve");
    seedRun("r5", "card-a", "critique", "2024-01-05T00:00:00.000Z", "revise");
    expect(consecutiveCriticRevisions("card-a")).toBe(2);

    // card-b: no loop run, so every revise counts; other cards' rows do not.
    seedRun("r6", "card-b", "critique", "2024-01-01T00:00:00.000Z", "revise");
    expect(consecutiveCriticRevisions("card-b")).toBe(1);
    expect(consecutiveCriticRevisions("card-none")).toBe(0);
  });
});

describe("PlanCriticService.runCritic", () => {
  const HEAD = "abc123";

  function seedRepo() {
    db.insert(repos)
      .values({ id: "repo-1", name: "Repo", path: path.join(testDataDir, "repo"), defaultBranch: "main", createdAt: now() })
      .run();
  }

  /** A card in `planning` with a plan row and the planner's worktree run,
   * whose worktree is a real temp dir with an empty `.ralph/`. */
  function seedPlannedCard(id: string, reviewPlanBeforeImplementation: 0 | 1 = 0) {
    db.insert(cards)
      .values({
        id,
        repoId: "repo-1",
        title: `Card ${id}`,
        description: "See specs/30-plan-critic.md",
        status: "planning",
        baseBranch: "main",
        reviewPlanBeforeImplementation,
        position: 1,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    db.insert(plans)
      .values({
        id: `plan-${id}`,
        cardId: id,
        version: 1,
        planMd: "## Tasks\n- [ ] do the thing\n",
        promptMd: "Do the thing.",
        acceptanceCriteria: "The thing is done.",
        createdAt: now(),
      })
      .run();
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-critic-wt-"));
    fs.mkdirSync(path.join(worktreePath, ".ralph"), { recursive: true });
    db.insert(runs)
      .values({
        id: `plan-run-${id}`,
        cardId: id,
        planId: `plan-${id}`,
        kind: "plan",
        status: "completed",
        exitReason: "plan artifacts written",
        worktreePath,
        branch: `ralph/${id}`,
        baseBranch: "main",
        startedAt: "2024-01-01T00:00:00.000Z",
        endedAt: "2024-01-01T00:01:00.000Z",
      })
      .run();
    return worktreePath;
  }

  function seedPriorRevise(cardId: string, n: number) {
    db.insert(runs)
      .values({
        id: `critique-prior-${cardId}-${n}`,
        cardId,
        planId: `plan-${cardId}`,
        kind: "critique",
        status: "completed",
        exitReason: "revise",
        feedback: `prior revise ${n}`,
        worktreePath: "/tmp/wt",
        branch: `ralph/${cardId}`,
        startedAt: `2024-01-02T00:0${n}:00.000Z`,
        endedAt: `2024-01-02T00:0${n}:30.000Z`,
      })
      .run();
  }

  /** Queue runHarness to write the given worktree-relative files. */
  function mockCriticHarness(files: Record<string, string>) {
    mocks.runHarness.mockImplementationOnce(async ({ cwd }: { cwd: string }) => {
      for (const [rel, content] of Object.entries(files)) {
        const target = path.join(cwd, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      return { timedOut: false, stalled: false, error: "", code: 0, lastText: "done" };
    });
  }

  /** `tryGit` answering rev-parse with a constant and status with the given
   * porcelain outputs, in call order (the last one repeats). */
  function mockGit(statusOutputs: string[] = [""]) {
    let statusCalls = 0;
    mocks.tryGit.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "rev-parse") return { ok: true, out: HEAD };
      if (args[0] === "status") {
        const out = statusOutputs[Math.min(statusCalls, statusOutputs.length - 1)];
        statusCalls += 1;
        return { ok: true, out };
      }
      return { ok: true, out: "" };
    });
  }

  function makeDeps() {
    return {
      getCard: (id: string) => db.select().from(cards).where(eq(cards.id, id)).get(),
      workerId: () => "worker-test",
      latestPlan: (id: string) => db.select().from(plans).where(eq(plans.cardId, id)).get(),
      latestWorktreeRun: (id: string) =>
        db.select().from(runs).where(eq(runs.id, `plan-run-${id}`)).get(),
      moveCard: vi.fn(() => true),
      finishRun: vi.fn(() => true),
      registerController: vi.fn(),
      releaseController: vi.fn(),
      pump: vi.fn(),
      replan: vi.fn(),
    };
  }

  const critiqueRun = (cardId: string) =>
    db.select().from(runs).where(eq(runs.cardId, cardId)).all().find((r) => r.kind === "critique")!;

  beforeEach(() => {
    db.delete(events).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.offRunBranchReason.mockResolvedValue(null);
    mockGit();
    seedRepo();
  });

  it("approves: finishes the run, moves the card to ready and records the decision", async () => {
    const worktreePath = seedPlannedCard("card-approve");
    mockCriticHarness({ [`.ralph/${CRITIQUE_FILE}`]: "VERDICT: approve\nLooks complete.\n" });
    const deps = makeDeps();

    await new PlanCriticService(deps).runCritic("card-approve");

    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "completed", "approve", expect.any(Object));
    expect(deps.moveCard).toHaveBeenCalledWith("card-approve", "planning", "ready", "plan critic approved");
    expect(deps.replan).not.toHaveBeenCalled();
    expect(mocks.runHarness).toHaveBeenCalledTimes(1);
    const call = mocks.runHarness.mock.calls[0][0];
    expect(call).toMatchObject({
      timeoutMs: 7 * 60 * 1000,
      role: "planner",
      cwd: worktreePath,
      model: "critic-model",
    });
    expect(call.transcriptPath).toMatch(/critique\.jsonl$/);
    expect(call.prompt).toContain("Critique Card card-approve");
    expect(call.prompt).toContain("- [ ] do the thing");
    const decided = db.select().from(events).where(eq(events.type, "critique.decided")).all();
    expect(decided).toHaveLength(1);
    expect(JSON.parse(decided[0].payload)).toMatchObject({ verdict: "approve", planVersion: 1 });
    expect(critiqueRun("card-approve")).toMatchObject({ planId: "plan-card-approve", worktreePath });
    // Nothing is committed, so the verdict must not linger in the worktree.
    expect(fs.existsSync(path.join(worktreePath, ".ralph", CRITIQUE_FILE))).toBe(false);
    expect(deps.pump).toHaveBeenCalled();
  });

  it("approves into plan_review for a card that opted into human plan review", async () => {
    seedPlannedCard("card-review", 1);
    mockCriticHarness({ [`.ralph/${CRITIQUE_FILE}`]: "VERDICT: approve\nFine.\n" });
    const deps = makeDeps();

    await new PlanCriticService(deps).runCritic("card-review");

    expect(deps.moveCard).toHaveBeenCalledWith("card-review", "planning", "plan_review", "plan critic approved");
  });

  it("revises: stores the feedback on the run and re-plans without moving the card", async () => {
    seedPlannedCard("card-revise");
    mockCriticHarness({ [`.ralph/${CRITIQUE_FILE}`]: "VERDICT: revise\nTask 2 ignores the spec's cap.\n" });
    const deps = makeDeps();

    await new PlanCriticService(deps).runCritic("card-revise");

    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "completed", "revise", expect.any(Object));
    expect(deps.replan).toHaveBeenCalledWith("card-revise");
    expect(deps.moveCard).not.toHaveBeenCalled();
    expect(critiqueRun("card-revise").feedback).toBe("Task 2 ignores the spec's cap.");
  });

  it("escalates to plan_review once two prior revisions are on record", async () => {
    seedPlannedCard("card-limit");
    seedPriorRevise("card-limit", 1);
    seedPriorRevise("card-limit", 2);
    mockCriticHarness({ [`.ralph/${CRITIQUE_FILE}`]: "VERDICT: revise\nStill wrong.\n" });
    const deps = makeDeps();

    await new PlanCriticService(deps).runCritic("card-limit");

    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      "revise — revision limit reached",
      expect.any(Object),
    );
    expect(deps.moveCard).toHaveBeenCalledWith(
      "card-limit",
      "planning",
      "plan_review",
      expect.stringContaining("revision limit"),
    );
    expect(deps.replan).not.toHaveBeenCalled();
  });

  it("rejects a verdict when the critic touched anything but its verdict file", async () => {
    seedPlannedCard("card-illegal");
    mockGit(["", " M src/extra.ts\n?? .ralph/CRITIQUE.md"]);
    mockCriticHarness({
      [`.ralph/${CRITIQUE_FILE}`]: "VERDICT: approve\nFine.\n",
      "src/extra.ts": "export const sneaky = true;\n",
    });
    const deps = makeDeps();

    await new PlanCriticService(deps).runCritic("card-illegal");

    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "failed",
      expect.stringContaining("verdict rejected"),
      expect.any(Object),
    );
    expect(deps.moveCard).toHaveBeenCalledWith(
      "card-illegal",
      "planning",
      "needs_attention",
      expect.stringContaining("src/extra.ts"),
    );
    expect(deps.replan).not.toHaveBeenCalled();
  });

  it("fails loudly on a malformed verdict", async () => {
    seedPlannedCard("card-malformed");
    mockCriticHarness({ [`.ralph/${CRITIQUE_FILE}`]: "I think it is fine.\n" });
    const deps = makeDeps();

    await new PlanCriticService(deps).runCritic("card-malformed");

    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "failed",
      "plan critic wrote no usable VERDICT in .ralph/CRITIQUE.md",
      expect.any(Object),
    );
    expect(deps.moveCard).toHaveBeenCalledWith(
      "card-malformed",
      "planning",
      "needs_attention",
      "plan critic wrote no usable VERDICT in .ralph/CRITIQUE.md",
    );
  });
});
