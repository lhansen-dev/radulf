import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The DB must open against a throwaway data dir, so the env var is set before
// the module (and its import-time path resolution) loads.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-schema-"));
process.env.RADULF_DATA_DIR = testDataDir;

const { db, now, repos, runs, cards, DATA_DIR, WORKTREES_DIR, PLANS_DIR } =
  await import("@/db");

afterAll(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.RADULF_DATA_DIR;
});

describe("spec 14 directory layout", () => {
  it("keeps worktrees and plans OUTSIDE data/ (sandbox denies data/ wholesale)", () => {
    expect(WORKTREES_DIR.startsWith(DATA_DIR + path.sep)).toBe(false);
    expect(PLANS_DIR.startsWith(DATA_DIR + path.sep)).toBe(false);
    expect(WORKTREES_DIR).toBe(path.join(path.dirname(DATA_DIR), "worktrees"));
    expect(PLANS_DIR).toBe(path.join(path.dirname(DATA_DIR), "plans"));
  });
});

describe("spec 14 schema additions", () => {
  it("round-trips the sandbox run metadata", () => {
    db.insert(repos)
      .values({ id: "r1", name: "repo", path: "/tmp/repo", createdAt: now() })
      .run();
    db.insert(cards)
      .values({ id: "c1", repoId: "r1", title: "t", createdAt: now(), updatedAt: now() })
      .run();
    db.insert(runs)
      .values({
        id: "run1",
        cardId: "c1",
        kind: "loop",
        worktreePath: "/tmp/wt",
        branch: "ralph/x",
        startedAt: now(),
        sandboxed: 1,
        diskLimitMechanism: "watchdog",
      })
      .run();

    const row = db.select().from(runs).all()[0];
    expect(row.sandboxed).toBe(1);
    expect(row.diskLimitMechanism).toBe("watchdog");
  });

  it("stores null sandbox metadata for legacy rows", () => {
    db.insert(runs)
      .values({
        id: "run2",
        cardId: "c1",
        kind: "plan",
        worktreePath: "/tmp/wt2",
        branch: "ralph/y",
        startedAt: now(),
      })
      .run();
    const row = db.select().from(runs).all().find((r) => r.id === "run2")!;
    expect(row.sandboxed).toBeNull();
    expect(row.diskLimitMechanism).toBeNull();
  });

  it("defaults approvedInstallScripts to an empty JSON list and round-trips entries", () => {
    const fresh = db.select().from(repos).all()[0];
    expect(JSON.parse(fresh.approvedInstallScripts)).toEqual([]);

    const approved = [{ name: "esbuild", version: "0.21.0", scriptHash: "abc123" }];
    db.update(repos).set({ approvedInstallScripts: JSON.stringify(approved) }).run();
    const updated = db.select().from(repos).all()[0];
    expect(JSON.parse(updated.approvedInstallScripts)).toEqual(approved);
  });
});
