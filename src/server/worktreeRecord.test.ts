import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-worktree-record-"));
process.env.RADULF_DATA_DIR = testDataDir;

const { db, now, cards, repos, runs, worktrees } = await import("@/db");
const { recordWorktree } = await import("./git");

afterAll(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.RADULF_DATA_DIR;
});

beforeEach(() => {
  db.delete(worktrees).run();
  db.delete(runs).run();
  db.delete(cards).run();
  db.delete(repos).run();
  db.insert(repos)
    .values({ id: "repo-1", name: "r", path: "/tmp/r", defaultBranch: "main", createdAt: now() })
    .run();
  db.insert(cards)
    .values({ id: "card-1", repoId: "repo-1", title: "t", createdAt: now(), updatedAt: now() })
    .run();
});

// worktrees.runId is a real foreign key (foreign_keys=ON) — recordWorktree
// must only ever be called after its runId's `runs` row exists. This pins
// the contract that let a real bug ship: createWorktree used to insert this
// row itself, before the caller's `runs` insert, and every fresh worktree
// creation threw "FOREIGN KEY constraint failed".
describe("recordWorktree", () => {
  it("succeeds once the owning run row exists", () => {
    db.insert(runs)
      .values({
        id: "run-1",
        cardId: "card-1",
        kind: "plan",
        worktreePath: "/tmp/wt1",
        branch: "ralph/wt1",
        baseBranch: "main",
        provider: "anthropic",
        model: "m",
        startedAt: now(),
      })
      .run();

    expect(() => recordWorktree("repo-1", "run-1", "/tmp/wt1", "ralph/wt1")).not.toThrow();
    const row = db.select().from(worktrees).all().find((w) => w.path === "/tmp/wt1");
    expect(row?.runId).toBe("run-1");
  });

  it("throws a FK error when the run row does not exist yet", () => {
    expect(() => recordWorktree("repo-1", "run-does-not-exist", "/tmp/wt2", "ralph/wt2")).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});
