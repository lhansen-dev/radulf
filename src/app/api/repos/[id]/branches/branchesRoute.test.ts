import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";
import { git, initScratchRepo } from "@/testUtils/gitRepo";

setupTestDataDir("radulf-branches-route-");

const { db, repos, now } = await import("@/db");
const { GET, POST } = await import("./route");

const ctx = { params: Promise.resolve({ id: "repo-1" }) };
let repo: string;

beforeAll(() => {
  repo = initScratchRepo("radulf-branches-repo-");
  git(repo, "branch", "feature-x");
  git(repo, "branch", "ralph/some-card-abc123");
  git(repo, "branch", "ralph/improve-1753500000000");
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo", path: repo, defaultBranch: "main", createdAt: now() })
    .run();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("GET /api/repos/:id/branches", () => {
  it("lists the repo's branches without Radulf's own ralph/* branches", async () => {
    const response = await GET(new Request("http://localhost/api/repos/repo-1/branches"), ctx);

    expect(response.status).toBe(200);
    const branches = (await response.json()) as string[];
    expect(branches).toEqual(expect.arrayContaining(["main", "feature-x"]));
    expect(branches.filter((branch) => branch.startsWith("ralph/"))).toEqual([]);
  });

  it("returns 404 for an unknown repo", async () => {
    const response = await GET(new Request("http://localhost/api/repos/nope/branches"), {
      params: Promise.resolve({ id: "nope" }),
    });

    expect(response.status).toBe(404);
  });
});

describe("POST /api/repos/:id/branches", () => {
  function post(body: unknown) {
    return POST(
      new Request("http://localhost/api/repos/repo-1/branches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      ctx,
    );
  }

  it("rejects a name that is already a branch", async () => {
    const response = await post({ name: "feature-x" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "branch already exists" });
  });

  it("rejects a base branch the repo does not have", async () => {
    const response = await post({ name: "brand-new", from: "nope" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "base branch does not exist in the repository" });
  });
});
