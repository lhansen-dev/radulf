import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-branches-route-"));
process.env.RADULF_DATA_DIR = testDataDir;

const { db, repos, now } = await import("@/db");
const { GET } = await import("./route");

function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

const ctx = { params: Promise.resolve({ id: "repo-1" }) };
let repo: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-branches-repo-"));
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "test@test.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "# test");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  git(repo, "branch", "feature-x");
  git(repo, "branch", "ralph/some-card-abc123");
  git(repo, "branch", "ralph/improve-1753500000000");
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo", path: repo, defaultBranch: "main", createdAt: now() })
    .run();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.RADULF_DATA_DIR;
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
