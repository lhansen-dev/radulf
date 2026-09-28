import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-retention-");

const { db, settings, cards, repos, runs, worktrees, now, DATA_DIR } = await import("@/db");
const { saveBaseline } = await import("./integrity");
const { claimDailySweep, removeFinishedWorktrees, sweepDayKey, RETENTION_SWEEP_MARKER_KEY } = await import("./retention");
const { git, initScratchRepo } = await import("@/testUtils/gitRepo");

function markerValue(): string | undefined {
  return db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, RETENTION_SWEEP_MARKER_KEY))
    .get()?.value;
}

describe("claimDailySweep", () => {
  beforeEach(() => {
    db.delete(settings).run();
  });

  it("lets exactly one of two workers claim the same day", () => {
    const at = new Date("2026-09-24T10:00:00Z");
    // Worker A and worker B both reach their sweep timer on the same UTC day.
    expect(claimDailySweep(at)).toBe(true);
    expect(claimDailySweep(at)).toBe(false);
    expect(markerValue()).toBe("2026-09-24");
    expect(RETENTION_SWEEP_MARKER_KEY).toBe("retentionSweepDay");
  });

  it("opens up again on the next day", () => {
    expect(claimDailySweep(new Date("2026-09-24T10:00:00Z"))).toBe(true);
    expect(claimDailySweep(new Date("2026-09-24T23:00:00Z"))).toBe(false);
    expect(claimDailySweep(new Date("2026-09-25T00:30:00Z"))).toBe(true);
    expect(claimDailySweep(new Date("2026-09-25T08:00:00Z"))).toBe(false);
    expect(markerValue()).toBe("2026-09-25");
  });
});

describe("sweepDayKey", () => {
  it("is the UTC calendar date", () => {
    expect(sweepDayKey(new Date("2026-09-24T23:59:59Z"))).toBe("2026-09-24");
  });
});

describe("removeFinishedWorktrees", () => {
  function seed(cardId: string, status: "done" | "abandoned" | "review", repoPath: string) {
    const worktreePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ralph-abandoned-wt-")), "wt");
    const branch = `ralph/${cardId}`;
    git(repoPath, "worktree", "add", worktreePath, "-b", branch);
    db.insert(cards)
      .values({ id: cardId, repoId: "repo-1", title: cardId, description: "", status, position: 1, createdAt: now(), updatedAt: now() })
      .run();
    db.insert(runs)
      .values({ id: `run-${cardId}`, cardId, kind: "plan", status: "completed", worktreePath, branch, startedAt: now(), endedAt: now() })
      .run();
    db.insert(worktrees)
      .values({ id: `wt-${cardId}`, repoId: "repo-1", runId: `run-${cardId}`, path: worktreePath, branch, createdAt: now() })
      .run();
    // The delivery worker's integrity baseline, keyed by run id.
    saveBaseline(`run-${cardId}`, {} as never);
    return {
      worktreePath,
      branch,
      baselinePath: path.join(DATA_DIR, "integrity", `run-${cardId}.json`),
    };
  }

  beforeEach(() => {
    db.delete(worktrees).run();
    db.delete(runs).run();
    db.delete(cards).run();
    db.delete(repos).run();
  });

  it("reclaims the worktree and branch of an abandoned card and leaves other cards' alone", async () => {
    const repoPath = initScratchRepo("ralph-abandoned-repo-");
    db.insert(repos).values({ id: "repo-1", name: "repo", path: repoPath, defaultBranch: "main", createdAt: now() }).run();
    const gone = seed("card-gone", "abandoned", repoPath);
    const kept = seed("card-kept", "review", repoPath);

    expect(await removeFinishedWorktrees()).toBe(1);

    expect(fs.existsSync(gone.worktreePath)).toBe(false);
    expect(fs.existsSync(kept.worktreePath)).toBe(true);
    expect(git(repoPath, "branch", "--list", gone.branch)).toBe("");
    expect(git(repoPath, "branch", "--list", kept.branch)).toContain(kept.branch);
    const rows = db.select().from(worktrees).all();
    expect(rows.find((r) => r.id === "wt-card-gone")?.removedAt).not.toBeNull();
    expect(rows.find((r) => r.id === "wt-card-kept")?.removedAt).toBeNull();

    // Idempotent: nothing left to do, nothing breaks.
    expect(await removeFinishedWorktrees()).toBe(0);
  });

  it("reclaims the worktree, branch, row and baseline of a done card and leaves a review card's alone", async () => {
    const repoPath = initScratchRepo("ralph-done-repo-");
    db.insert(repos).values({ id: "repo-1", name: "repo", path: repoPath, defaultBranch: "main", createdAt: now() }).run();
    // A delivery worker died after completeApproval moved the card to done
    // and before it removed the worktree.
    const landed = seed("card-done", "done", repoPath);
    const kept = seed("card-review", "review", repoPath);
    expect(fs.existsSync(landed.baselinePath)).toBe(true);

    expect(await removeFinishedWorktrees()).toBe(1);

    expect(fs.existsSync(landed.worktreePath)).toBe(false);
    expect(fs.existsSync(landed.baselinePath)).toBe(false);
    expect(git(repoPath, "branch", "--list", landed.branch)).toBe("");
    expect(db.select().from(worktrees).all().find((r) => r.id === "wt-card-done")?.removedAt).not.toBeNull();

    expect(fs.existsSync(kept.worktreePath)).toBe(true);
    expect(fs.existsSync(kept.baselinePath)).toBe(true);
    expect(git(repoPath, "branch", "--list", kept.branch)).toContain(kept.branch);
    expect(db.select().from(worktrees).all().find((r) => r.id === "wt-card-review")?.removedAt).toBeNull();

    // Idempotent: the finished card is already fully reclaimed.
    expect(await removeFinishedWorktrees()).toBe(0);
  });

  it("a baseline that cannot be deleted leaves the worktree, branch and row for a retry", async () => {
    const repoPath = initScratchRepo("ralph-baseline-stuck-repo-");
    db.insert(repos).values({ id: "repo-1", name: "repo", path: repoPath, defaultBranch: "main", createdAt: now() }).run();
    const stuck = seed("card-stuck", "done", repoPath);

    // `removeBaseline` is `rmSync(path, { force: true })` without `recursive`,
    // so a non-empty DIRECTORY at the baseline path makes the deletion throw
    // (force only swallows ENOENT). Stands in for any failure of that step.
    fs.rmSync(stuck.baselinePath);
    fs.mkdirSync(stuck.baselinePath);
    fs.writeFileSync(path.join(stuck.baselinePath, "child"), "");

    await expect(removeFinishedWorktrees()).rejects.toThrow();

    // The baseline step runs FIRST, before the worktree is removed and before
    // `removeWorktree` stamps `removedAt` — so the throw left everything intact
    // and the row still selected (`removedAt IS NULL`) by the next tick.
    expect(fs.existsSync(stuck.worktreePath)).toBe(true);
    expect(git(repoPath, "branch", "--list", stuck.branch)).toContain(stuck.branch);
    expect(db.select().from(worktrees).all().find((r) => r.id === "wt-card-stuck")?.removedAt).toBeNull();

    // Repair the baseline path and the same sweep finishes the job.
    fs.rmSync(stuck.baselinePath, { recursive: true, force: true });
    expect(await removeFinishedWorktrees()).toBe(1);
    expect(fs.existsSync(stuck.worktreePath)).toBe(false);
    expect(git(repoPath, "branch", "--list", stuck.branch)).toBe("");
    expect(db.select().from(worktrees).all().find((r) => r.id === "wt-card-stuck")?.removedAt).not.toBeNull();
  });
});
