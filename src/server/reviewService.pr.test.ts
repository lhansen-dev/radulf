import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

// Spec 15 acceptance tests: delivering an approved diff as a GitHub pull
// request instead of merging it into the local base branch. The git and gh
// boundaries are mocked — what is under test is the decision and the ordering
// around them, not git's or gh's own behavior.

const mocks = vi.hoisted(() => ({
  mergeBranch: vi.fn(),
  mergeBaseIntoWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  hasRemote: vi.fn(),
  pushBranch: vi.fn(),
  stripRalphForDelivery: vi.fn(),
  githubStatus: vi.fn(),
  createPullRequest: vi.fn(),
  findOpenPullRequest: vi.fn(),
  invalidateGithubStatus: vi.fn(),
  // The four Jira fields exist because the Done announce (jiraAnnounce.ts) reads
  // the same mocked `getSettings` the delivery does; every spec 15 test leaves
  // the opt-in off, which is also its shipped default.
  settings: {
    openPr: false,
    autoApprove: false,
    jiraCommentOnDone: false,
    jiraBaseUrl: "",
    jiraEmail: "",
    jiraApiToken: "",
  },
}));

vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  mergeBranch: mocks.mergeBranch,
  mergeBaseIntoWorktree: mocks.mergeBaseIntoWorktree,
  removeWorktree: mocks.removeWorktree,
  hasRemote: mocks.hasRemote,
  pushBranch: mocks.pushBranch,
  stripRalphForDelivery: mocks.stripRalphForDelivery,
}));
vi.mock("./github", () => ({
  githubStatus: mocks.githubStatus,
  createPullRequest: mocks.createPullRequest,
  findOpenPullRequest: mocks.findOpenPullRequest,
  invalidateGithubStatus: mocks.invalidateGithubStatus,
}));
vi.mock("./settings", () => ({ getSettings: () => mocks.settings }));

const testDataDir = setupTestDataDir("radulf-reviewService-pr-");

const { db, cards, improvementRuns, plans, runs, repos, reviews, events, now } =
  await import("@/db");
const { ReviewService } = await import("./reviewService");

function seedRepo() {
  db.insert(repos)
    .values({
      id: "repo-1",
      name: "Repo",
      path: path.join(testDataDir, "repo"),
      defaultBranch: "main",
      createdAt: now(),
    })
    .run();
}

function seedCard(id: string, openPr: 0 | 1, jiraKey?: string) {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "PR delivery test card",
      status: "review",
      position: 1,
      openPr,
      jiraKey: jiraKey ?? null,
      summary: "The evaluator's summary of the change.",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function seedRun(cardId: string) {
  const planId = `plan-${cardId}`;
  db.insert(plans)
    .values({
      id: planId,
      cardId,
      version: 1,
      planMd: "## Tasks\n- [ ] implement the thing\n",
      promptMd: "Implement the thing.",
      acceptanceCriteria: "The thing is implemented.",
      createdAt: now(),
    })
    .run();
  const worktreePath = fs.mkdtempSync(path.join(testDataDir, "worktree-"));
  fs.mkdirSync(path.join(worktreePath, ".ralph"), { recursive: true });
  const id = `loop-${cardId}`;
  db.insert(runs)
    .values({
      id,
      cardId,
      planId,
      kind: "loop",
      status: "completed",
      worktreePath,
      branch: `ralph/${id}`,
      baseBranch: "main",
      startedAt: now(),
      endedAt: now(),
    })
    .run();
  return { id, worktreePath };
}

function makeDeps() {
  return {
    getCard: (id: string) => db.select().from(cards).where(eq(cards.id, id)).get(),
    latestPlan: (id: string) =>
      db.select().from(plans).where(eq(plans.cardId, id)).orderBy(desc(plans.version)).limit(1).get(),
    latestWorktreeRun: (id: string) =>
      db.select().from(runs).where(eq(runs.cardId, id)).orderBy(desc(runs.startedAt)).limit(1).get(),
    moveCard: vi.fn(() => true),
    pump: vi.fn(),
    workerId: () => "worker-test",
  };
}

/** Turns the Jira credentials on for a test and answers them: the tenant lookup
 * yields a cloud id (so the comment goes to the gateway, like every other Jira
 * call) and the comment POST succeeds. The `vi.fn` comes back so a test can
 * count the comment requests — exactly one is the point — and read its body. */
function stubJiraFetch() {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).endsWith("/_edge/tenant_info")
      ? new Response(JSON.stringify({ cloudId: "cloud-1" }), {
          headers: { "content-type": "application/json" },
        })
      : new Response("{}", { status: 201 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Turn Jira on the way Settings would: the opt-in plus a full set of
 * credentials. A blank field anywhere in here and the announce stays silent. */
function enableJiraComments() {
  mocks.settings.jiraCommentOnDone = true;
  mocks.settings.jiraBaseUrl = "https://example.atlassian.net";
  mocks.settings.jiraEmail = "me@example.com";
  mocks.settings.jiraApiToken = "tok";
}

/** The comment requests posted, ignoring the unauthenticated tenant lookup. The
 * mock only declares the url, so the init it actually received is read back out
 * through this one cast. */
function commentRequests(fetchMock: ReturnType<typeof stubJiraFetch>): [string, RequestInit][] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/comment"))
    .map((call) => call as unknown as [string, RequestInit]);
}

function decision(cardId: string): Record<string, unknown> | undefined {
  const row = db
    .select()
    .from(events)
    .where(and(eq(events.cardId, cardId), eq(events.type, "review.decided")))
    .orderBy(desc(events.id))
    .get();
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

describe("ReviewService — spec 15 pull-request delivery", () => {
  beforeEach(() => {
    db.delete(events).run();
    db.delete(improvementRuns).run();
    db.delete(reviews).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.settings.openPr = false;
    mocks.settings.autoApprove = false;
    mocks.settings.jiraCommentOnDone = false;
    mocks.settings.jiraBaseUrl = "";
    mocks.settings.jiraEmail = "";
    mocks.settings.jiraApiToken = "";
    mocks.mergeBranch.mockResolvedValue({ ok: true, mergeCommit: "abc123" });
    mocks.mergeBaseIntoWorktree.mockResolvedValue({ ok: true, conflicted: false, out: "" });
    mocks.removeWorktree.mockResolvedValue(undefined);
    mocks.hasRemote.mockResolvedValue(true);
    mocks.pushBranch.mockResolvedValue({ ok: true });
    mocks.stripRalphForDelivery.mockResolvedValue({ ok: true, out: "" });
    mocks.githubStatus.mockResolvedValue({ ok: true });
    mocks.createPullRequest.mockResolvedValue({
      ok: true,
      url: "https://github.com/o/r/pull/7",
    });
    mocks.findOpenPullRequest.mockResolvedValue({ ok: true, pr: null });
    seedRepo();
  });

  // The comment's `Card:` line falls back to the bare card id when Radulf has
  // not been told its own address, which is what these tests read back.
  let previousPublicBase: string | undefined;
  beforeEach(() => {
    previousPublicBase = process.env.RADULF_PUBLIC_BASE_URL;
    delete process.env.RADULF_PUBLIC_BASE_URL;
  });
  afterEach(() => {
    if (previousPublicBase === undefined) delete process.env.RADULF_PUBLIC_BASE_URL;
    else process.env.RADULF_PUBLIC_BASE_URL = previousPublicBase;
    vi.unstubAllGlobals();
  });

  it("1 — delivers by local merge and spawns no gh when PR delivery is off", async () => {
    seedCard("card-merge", 0);
    const run = seedRun("card-merge");

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result.ok).toBe(true);
    expect(mocks.mergeBranch).toHaveBeenCalledTimes(1);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });

  it("2 — pushes and opens a PR without merging locally", async () => {
    seedCard("card-pr", 1);
    const run = seedRun("card-pr");

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result.ok).toBe(true);
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(mocks.pushBranch).toHaveBeenCalledWith(run.worktreePath, "ralph/loop-card-pr");
    expect(mocks.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "main", branch: "ralph/loop-card-pr" }),
    );
    expect(decision("card-pr")).toMatchObject({
      delivery: "pr",
      prUrl: "https://github.com/o/r/pull/7",
    });
  });

  it("3 — the global setting grants delivery, and the event records which did", async () => {
    mocks.settings.openPr = true;
    seedCard("card-global", 0);
    const runGlobal = seedRun("card-global");
    await new ReviewService(makeDeps()).approve(runGlobal.id);
    expect(decision("card-global")).toMatchObject({ delivery: "pr", grantedBy: "global" });

    mocks.settings.openPr = false;
    seedCard("card-flag", 1);
    const runFlag = seedRun("card-flag");
    await new ReviewService(makeDeps()).approve(runFlag.id);
    expect(decision("card-flag")).toMatchObject({ delivery: "pr", grantedBy: "card" });
  });

  it("4 — a human approval opens a real PR, an auto-approved one opens a draft", async () => {
    seedCard("card-human", 1);
    const human = seedRun("card-human");
    await new ReviewService(makeDeps()).approve(human.id, "human");
    expect(mocks.createPullRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ draft: false }),
    );

    seedCard("card-auto", 1);
    const auto = seedRun("card-auto");
    await new ReviewService(makeDeps()).approve(auto.id, "auto");
    expect(mocks.createPullRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ draft: true }),
    );
  });

  it("5 — merges the base branch in before pushing, and hands a conflict back to the loop", async () => {
    seedCard("card-conflict", 1);
    const run = seedRun("card-conflict");
    mocks.mergeBaseIntoWorktree.mockResolvedValue({
      ok: false,
      conflicted: true,
      out: "CONFLICT (content): both modified src/a.ts",
    });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
    // Handed back for resolution rather than dead-ended, and — the point of
    // passing the merge result through — without a second merge attempt on a
    // worktree that already holds conflict markers.
    expect(mocks.mergeBaseIntoWorktree).toHaveBeenCalledTimes(1);
    expect(deps.moveCard).toHaveBeenLastCalledWith(
      "card-conflict",
      "reviewing",
      "ready",
      expect.stringContaining("merge conflict"),
    );
  });

  it("5b — strips .ralph after the base merge and before the push", async () => {
    seedCard("card-order", 1);
    const run = seedRun("card-order");
    const order: string[] = [];
    mocks.mergeBaseIntoWorktree.mockImplementation(async () => {
      order.push("merge-base");
      return { ok: true, conflicted: false, out: "" };
    });
    mocks.stripRalphForDelivery.mockImplementation(async () => {
      order.push("strip");
      return { ok: true, out: "" };
    });
    mocks.pushBranch.mockImplementation(async () => {
      order.push("push");
      return { ok: true };
    });

    await new ReviewService(makeDeps()).approve(run.id);

    // .ralph is excluded from every review surface, so a push that carried it
    // would publish content no human was shown; stripping after the base merge
    // keeps a hand-back to the loop from ever seeing stripped loop memory.
    expect(order).toEqual(["merge-base", "strip", "push"]);
  });

  it("6 — a failed push never falls back to merging, and leaves the card recoverable", async () => {
    seedCard("card-push-fail", 1);
    const run = seedRun("card-push-fail");
    mocks.pushBranch.mockResolvedValue({ ok: false, error: "rejected: non-fast-forward" });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(deps.moveCard).toHaveBeenLastCalledWith(
      "card-push-fail",
      "reviewing",
      "needs_attention",
      expect.stringContaining("non-fast-forward"),
    );
    expect(decision("card-push-fail")).toMatchObject({ delivery: "pr" });
  });

  it("6b — a failed gh pr create does not merge either", async () => {
    seedCard("card-gh-fail", 1);
    const run = seedRun("card-gh-fail");
    mocks.createPullRequest.mockResolvedValue({ ok: false, error: "no default branch" });

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result.ok).toBe(false);
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(db.select().from(reviews).all()).toHaveLength(0);
  });

  it("never applies the workspace toggle to an Improvement Run's own cards", async () => {
    // Improvement Runs accumulate by merging each approved card into a local
    // `ralph/improve-*` branch. That branch is not on any remote, so PR
    // delivery would not merely change the shape of the result — it would
    // break the run.
    mocks.settings.openPr = true;
    db.insert(improvementRuns)
      .values({
        id: "run-1",
        repoId: "repo-1",
        featureBranch: "ralph/improve-123",
        baseBranch: "main",
        deadlineAt: now(),
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    seedCard("card-improve", 0);
    const run = seedRun("card-improve");
    db.update(runs).set({ baseBranch: "ralph/improve-123" }).where(eq(runs.id, run.id)).run();

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result.ok).toBe(true);
    expect(mocks.mergeBranch).toHaveBeenCalledTimes(1);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });

  it("7 — unmet preconditions leave the card in review, not needs_attention", async () => {
    for (const [id, arrange, expected] of [
      [
        "card-no-gh",
        () => mocks.githubStatus.mockResolvedValue({ ok: false, reason: "missing", detail: "the GitHub CLI (`gh`) is not installed, not on PATH, or not executable" }),
        "not installed",
      ],
      [
        "card-no-auth",
        () => mocks.githubStatus.mockResolvedValue({ ok: false, reason: "unauthenticated", detail: "`gh` is not authenticated — run `gh auth login` in a terminal" }),
        "not authenticated",
      ],
      ["card-no-remote", () => mocks.hasRemote.mockResolvedValue(false), "no `origin`"],
    ] as [string, () => void, string][]) {
      // Reset both preconditions each round: each case must fail for its own
      // reason, not for the previous case's.
      mocks.githubStatus.mockResolvedValue({ ok: true });
      mocks.hasRemote.mockResolvedValue(true);
      arrange();
      seedCard(id, 1);
      const run = seedRun(id);
      const deps = makeDeps();

      const result = await new ReviewService(deps).approve(run.id);

      expect(result.ok).toBe(false);
      expect(result.error).toContain(expected);
      // Back to review, so the Approve button the operator just used is still
      // there once they have fixed the precondition outside Radulf.
      expect(deps.moveCard).toHaveBeenLastCalledWith(id, "reviewing", "review", expect.any(String));
      expect(mocks.pushBranch).not.toHaveBeenCalled();
    }
  });

  it("8 — a retried delivery adopts the PR an earlier attempt already opened", async () => {
    seedCard("card-existing", 1);
    const run = seedRun("card-existing");
    mocks.findOpenPullRequest.mockResolvedValue({
      ok: true,
      pr: { url: "https://github.com/o/r/pull/42", isDraft: true },
    });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id, "human");

    expect(result.ok).toBe(true);
    // The whole point: no second `gh pr create`, which would fail with "a pull
    // request for branch ... already exists".
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
    expect(mocks.findOpenPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: run.worktreePath,
        baseBranch: "main",
        branch: "ralph/loop-card-existing",
      }),
    );
    expect(deps.moveCard).toHaveBeenLastCalledWith("card-existing", "reviewing", "done");
    expect(db.select().from(reviews).all()).toHaveLength(1);
    expect(db.select().from(reviews).all()[0]!.decision).toBe("approved");
    expect(decision("card-existing")).toMatchObject({
      delivery: "pr",
      prUrl: "https://github.com/o/r/pull/42",
      alreadyOpen: true,
      draft: true,
    });
  });

  it("8b — a failed lookup still opens a PR and never merges", async () => {
    seedCard("card-lookup-fail", 1);
    const run = seedRun("card-lookup-fail");
    mocks.findOpenPullRequest.mockResolvedValue({ ok: false, error: "gh pr list failed" });

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result.ok).toBe(true);
    // An inconclusive lookup is not "no PR": delivery proceeds as it always
    // did, and a PR is opened rather than the diff being merged locally.
    expect(mocks.createPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(decision("card-lookup-fail")).toMatchObject({
      delivery: "pr",
      prUrl: "https://github.com/o/r/pull/7",
    });
    expect(decision("card-lookup-fail")).not.toHaveProperty("alreadyOpen");
  });

  it("8c — Retry merge from needs_attention lands a card whose PR already exists in done", async () => {
    seedCard("card-retry", 1);
    seedRun("card-retry");
    db.update(cards)
      .set({ status: "needs_attention" })
      .where(eq(cards.id, "card-retry"))
      .run();
    mocks.findOpenPullRequest.mockResolvedValue({
      ok: true,
      pr: { url: "https://github.com/o/r/pull/9", isDraft: false },
    });
    const deps = makeDeps();

    const result = await new ReviewService(deps).retryMerge("card-retry");

    expect(result.ok).toBe(true);
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
    expect(deps.moveCard).toHaveBeenLastCalledWith("card-retry", "reviewing", "done");
    expect(decision("card-retry")).toMatchObject({
      delivery: "pr",
      prUrl: "https://github.com/o/r/pull/9",
      alreadyOpen: true,
      draft: false,
    });
  });

  it("9 — comments on the Jira issue once the merged card is Done", async () => {
    enableJiraComments();
    const fetchMock = stubJiraFetch();
    seedCard("card-merge", 0, "DEV-7");
    const run = seedRun("card-merge");
    mocks.mergeBranch.mockResolvedValue({ ok: true, mergeCommit: "abc1234567" });

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result).toEqual({ ok: true });
    const posted = commentRequests(fetchMock).filter(([url]) =>
      String(url).endsWith("/rest/api/2/issue/DEV-7/comment"),
    );
    expect(posted).toHaveLength(1);
    const init = posted[0]![1];
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("me@example.com:tok").toString("base64")}`,
    });
    const body = String(JSON.parse(init.body as string).body);
    // What landed, where it landed, and how to get back to the card — all
    // things Radulf already knew, none of them invented.
    expect(body).toContain("Card card-merge");
    expect(body).toContain("main");
    expect(body).toContain("abc1234");
    expect(body).toContain("Card: card-merge");
    expect(
      db
        .select()
        .from(events)
        .where(and(eq(events.cardId, "card-merge"), eq(events.type, "jira.commented")))
        .all(),
    ).toHaveLength(1);
  });

  it("9b — comments the pull request URL when the card is Done", async () => {
    enableJiraComments();
    const fetchMock = stubJiraFetch();
    seedCard("card-pr-jira", 1, "DEV-8");
    const run = seedRun("card-pr-jira");
    mocks.createPullRequest.mockResolvedValue({ ok: true, url: "https://github.com/o/r/pull/9" });

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result.ok).toBe(true);
    const posted = commentRequests(fetchMock);
    expect(posted).toHaveLength(1);
    expect(String(JSON.parse(posted[0]![1].body as string).body)).toContain(
      "https://github.com/o/r/pull/9",
    );
  });

  it("9c — writes nothing to Jira while the opt-in is off", async () => {
    mocks.settings.jiraBaseUrl = "https://example.atlassian.net";
    mocks.settings.jiraEmail = "me@example.com";
    mocks.settings.jiraApiToken = "tok";
    const fetchMock = stubJiraFetch();
    seedCard("card-off", 0, "DEV-9");
    const run = seedRun("card-off");

    expect((await new ReviewService(makeDeps()).approve(run.id)).ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("9d — writes nothing to Jira for a card with no issue key", async () => {
    enableJiraComments();
    const fetchMock = stubJiraFetch();
    seedCard("card-no-key", 0);
    const run = seedRun("card-no-key");

    expect((await new ReviewService(makeDeps()).approve(run.id)).ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("9e — still comments when the cleanup after Done throws", async () => {
    // The announce sits before the worktree cleanup on purpose: cleanup can
    // throw, the card stays Done, and a second approval returns early on the
    // review row — so an announce placed after it would be lost for good.
    enableJiraComments();
    const fetchMock = stubJiraFetch();
    seedCard("card-cleanup", 0, "DEV-11");
    const run = seedRun("card-cleanup");
    mocks.removeWorktree.mockRejectedValueOnce(new Error("worktree busy"));
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("worktree busy");
    expect(deps.moveCard).toHaveBeenCalledWith("card-cleanup", "reviewing", "done");
    expect(commentRequests(fetchMock)).toHaveLength(1);
  });
});
