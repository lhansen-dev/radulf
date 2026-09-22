import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";
import { eq } from "drizzle-orm";

// The DB must open against a throwaway data dir, so the env var is set before
// the module (and its import-time path resolution) loads.
setupTestDataDir("radulf-schema-");

const {
  db,
  now,
  repos,
  runs,
  cards,
  worktrees,
  settings,
  readSettingJson,
  upsertSettingJson,
  DATA_DIR,
  WORKTREES_DIR,
  PLANS_DIR,
} = await import("@/db");

describe("spec 14 directory layout", () => {
  it("keeps worktrees and plans OUTSIDE data/ (sandbox denies data/ wholesale)", () => {
    expect(WORKTREES_DIR.startsWith(DATA_DIR + path.sep)).toBe(false);
    expect(PLANS_DIR.startsWith(DATA_DIR + path.sep)).toBe(false);
    expect(WORKTREES_DIR).toBe(path.join(path.dirname(DATA_DIR), "worktrees"));
    expect(PLANS_DIR).toBe(path.join(path.dirname(DATA_DIR), "plans"));
  });
});

describe("schema defaults and constraints", () => {
  it("defaults new cards to Backlog and repos to an empty install-script approval list", () => {
    db.insert(repos).values({ id: "r1", name: "repo", path: "/tmp/repo", createdAt: now() }).run();
    db.insert(cards).values({ id: "c1", repoId: "r1", title: "t", createdAt: now(), updatedAt: now() }).run();

    expect(db.select().from(cards).get()!.status).toBe("backlog");
    expect(JSON.parse(db.select().from(repos).get()!.approvedInstallScripts)).toEqual([]);
  });

  it("set-nulls a worktree row's runId when its run is deleted", () => {
    db.insert(runs)
      .values({ id: "run1", cardId: "c1", kind: "loop", worktreePath: "/tmp/wt", branch: "ralph/x", startedAt: now() })
      .run();
    db.insert(worktrees)
      .values({ id: "wt1", repoId: "r1", runId: "run1", path: "/tmp/wt", branch: "ralph/x", createdAt: now() })
      .run();

    db.delete(runs).where(eq(runs.id, "run1")).run();
    const row = db.select().from(worktrees).where(eq(worktrees.id, "wt1")).get()!;
    expect(row.runId).toBeNull();
    expect(row.removedAt).toBeNull();
  });
});

describe("settings KV JSON helpers", () => {
  it("upserts one row per key and reads it back parsed", () => {
    upsertSettingJson("kv:test", { a: 1 });
    upsertSettingJson("kv:test", { a: 2 });
    expect(db.select().from(settings).where(eq(settings.key, "kv:test")).all()).toHaveLength(1);
    expect(readSettingJson("kv:test")).toEqual({ a: 2 });
  });

  it("reads a missing or corrupt row as null", () => {
    expect(readSettingJson("kv:absent")).toBeNull();
    db.insert(settings).values({ key: "kv:corrupt", value: "not json" }).run();
    expect(readSettingJson("kv:corrupt")).toBeNull();
  });
});
