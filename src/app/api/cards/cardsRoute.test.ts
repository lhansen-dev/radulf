import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";
import { git, initScratchRepo } from "@/testUtils/gitRepo";

const mocks = vi.hoisted(() => ({ pump: vi.fn() }));

vi.mock("@/server/orchestrator", () => ({
  getOrchestrator: () => ({ pump: mocks.pump }),
}));

setupTestDataDir("radulf-cards-route-");

const { db, cards, repos, now } = await import("@/db");
const { POST } = await import("./route");

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
