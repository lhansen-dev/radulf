import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";
import { git, initScratchRepo } from "@/testUtils/gitRepo";

const mocks = vi.hoisted(() => ({ pump: vi.fn() }));

vi.mock("@/server/orchestrator", () => ({
  getOrchestrator: () => ({ pump: mocks.pump }),
}));

setupTestDataDir("radulf-cards-route-");

const { db, cards, repos, runs, now } = await import("@/db");
const { planStatePath } = await import("@/server/bookkeeping");
const { GET, POST } = await import("./route");

function post(body: unknown) {
  return new Request("http://localhost/api/cards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let repo: string;

beforeAll(() => {
  repo = initScratchRepo("radulf-cards-repo-");
  git(repo, "branch", "feature-x");
  // A run branch whose card is gone: it exists, so the existence check alone
  // would let it through.
  git(repo, "branch", "ralph/orphan-card-abc123");
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo", path: repo, defaultBranch: "main", createdAt: now() })
    .run();
});

beforeEach(() => {
  db.delete(cards).run();
  vi.clearAllMocks();
});

const PLAN = `# Plan

## Tasks

- [x] Read the existing parser
- [x] Add the flag
- [ ] Wire the board badge
- [ ] Write the test
`;

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("POST /api/cards", () => {
  it("refuses one of Radulf's own ralph/* branches as the base even though it exists", async () => {
    const response = await POST(
      post({ repoId: "repo-1", title: "Card", baseBranch: "ralph/orphan-card-abc123" }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/ralph\/\*/);
    expect(db.select().from(cards).all()).toHaveLength(0);
    expect(mocks.pump).not.toHaveBeenCalled();
  });

  it("still accepts an ordinary branch as the base", async () => {
    const response = await POST(post({ repoId: "repo-1", title: "Card", baseBranch: "feature-x" }));

    expect(response.status).toBe(201);
    expect((await response.json()).baseBranch).toBe("feature-x");
    expect(db.select().from(cards).all()).toHaveLength(1);
    expect(mocks.pump).toHaveBeenCalledTimes(1);
  });

  it("still rejects a branch that does not exist", async () => {
    const response = await POST(post({ repoId: "repo-1", title: "Card", baseBranch: "nope" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/does not exist/);
  });
});

describe("GET /api/cards", () => {
  it("says which checklist task a looping card is on and how many are left", async () => {
    db.insert(cards)
      .values({
        id: "card-1",
        repoId: "repo-1",
        title: "Expose each loop's task item",
        status: "looping",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    db.insert(runs)
      .values({
        id: "run-1",
        cardId: "card-1",
        kind: "loop",
        status: "running",
        branch: "ralph/card-1",
        worktreePath: "/tmp/wt",
        startedAt: now(),
      })
      .run();
    fs.mkdirSync(path.dirname(planStatePath("card-1")), { recursive: true });
    fs.writeFileSync(planStatePath("card-1"), PLAN);

    const [card] = await (await GET()).json();

    // Upstream issue 34: the task text alone said what the loop was doing,
    // never how much was left. The current task is unfinished, so two remain.
    expect(card.latestRun.currentTask).toEqual({
      number: 3,
      count: 4,
      left: 2,
      text: "Wire the board badge",
    });
  });
});
