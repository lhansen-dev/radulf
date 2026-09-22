import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  deniedPathMessage,
  guardPath,
  isInsideOrEqual,
  pathBoundaryMessage,
  realpathBestEffort,
} from "./pathGuard";

// A real on-disk worktree with a sibling `-evil` dir and a planted symlink.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pathguard-"));
const worktree = path.join(tmp, "wt");
const evil = path.join(tmp, "wt-evil"); // sibling that shares the string prefix
const outside = path.join(tmp, "outside", "secret.txt");
fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
fs.mkdirSync(evil, { recursive: true });
fs.mkdirSync(path.dirname(outside), { recursive: true });
fs.writeFileSync(path.join(worktree, "src", "a.ts"), "ok");
fs.writeFileSync(outside, "secret");
fs.writeFileSync(path.join(evil, "b.ts"), "nope");
// A symlink inside the worktree pointing at the outside secret.
const link = path.join(worktree, "link");
fs.symlinkSync(outside, link);

const roots = [worktree];

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("guardPath — spec 14 Layer 2 containment", () => {
  // Per-role roots (e.g. the planner's .ralph-only writes) are exercised
  // end-to-end through the real tools in harness/l2Acceptance.test.ts.
  it("allows the root, paths inside it, and not-yet-existing files, returning realpaths", () => {
    const realWorktree = fs.realpathSync(worktree);
    expect(guardPath(".", roots, worktree)).toBe(realWorktree);
    expect(guardPath("src/a.ts", roots, worktree)).toBe(path.join(realWorktree, "src", "a.ts"));
    expect(guardPath("src/new/deep/file.ts", roots, worktree)).toBe(
      path.join(realWorktree, "src", "new", "deep", "file.ts"),
    );
  });

  it.each([
    ["an absolute path outside every root", outside],
    // <worktree>-evil is NOT inside <worktree>.
    ["a sibling that only shares a string prefix", path.join(evil, "b.ts")],
    // realpath resolution defeats the symlink launder (checklist #5).
    ["a symlink inside the worktree targeting an outside path", "link"],
    // The temp worktree is under os.tmpdir(), never under HOME.
    ["a ~-expanded path under $HOME", "~/.ssh/id_ed25519"],
  ])("rejects %s", (_label, p) => {
    expect(() => guardPath(p, roots, worktree)).toThrow(pathBoundaryMessage(roots));
  });

  it("rejects a path inside a denied root even when it is inside an allowed one", () => {
    // A linked worktree's `.git` is a file; a path "under" it still resolves
    // through realpathBestEffort to the file plus a tail, and is denied too.
    const dotGit = path.join(worktree, ".git");
    fs.writeFileSync(dotGit, "gitdir: /somewhere/else");
    const denied = [dotGit];
    expect(() => guardPath(".git", roots, worktree, denied)).toThrow(deniedPathMessage(denied));
    expect(() => guardPath(".git/config", roots, worktree, denied)).toThrow(deniedPathMessage(denied));
    expect(guardPath("src/a.ts", roots, worktree, denied)).toBe(
      path.join(fs.realpathSync(worktree), "src", "a.ts"),
    );
  });
});

describe("isInsideOrEqual — segment comparison", () => {
  it.each([
    ["/a/b", "/a/b", true],
    ["/a/b/c", "/a/b", true],
    ["/a/b-evil", "/a/b", false],
    ["/a", "/a/b", false],
  ])("%s inside %s → %s", (child, parent, expected) => {
    expect(isInsideOrEqual(child, parent)).toBe(expected);
  });
});

describe("realpathBestEffort", () => {
  it("resolves the deepest existing ancestor through symlinks and re-appends the tail", () => {
    const realSrc = fs.realpathSync(path.join(worktree, "src"));
    expect(realpathBestEffort(path.join(worktree, "src"))).toBe(realSrc);
    expect(realpathBestEffort(path.join(worktree, "src", "no", "such"))).toBe(path.join(realSrc, "no", "such"));
  });
});
