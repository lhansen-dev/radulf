import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
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
  it("allows a path inside a root and returns its realpath", () => {
    const resolved = guardPath("src/a.ts", roots, worktree);
    expect(resolved).toBe(fs.realpathSync(path.join(worktree, "src", "a.ts")));
  });

  it("allows a not-yet-existing file under a root (write/edit create)", () => {
    const resolved = guardPath("src/new/deep/file.ts", roots, worktree);
    expect(resolved.startsWith(fs.realpathSync(worktree) + path.sep)).toBe(true);
  });

  it("allows the root itself", () => {
    expect(() => guardPath(".", roots, worktree)).not.toThrow();
  });

  it("rejects an absolute path outside every root", () => {
    expect(() => guardPath(outside, roots, worktree)).toThrow(
      pathBoundaryMessage(roots),
    );
  });

  it("rejects a sibling that only shares a string prefix (segment-safe)", () => {
    // <worktree>-evil is NOT inside <worktree>.
    expect(() => guardPath(path.join(evil, "b.ts"), roots, worktree)).toThrow(
      pathBoundaryMessage(roots),
    );
  });

  it("rejects a symlink inside the worktree that targets an outside path", () => {
    // realpath resolution defeats the symlink launder (checklist #5).
    expect(() => guardPath("link", roots, worktree)).toThrow(
      pathBoundaryMessage(roots),
    );
  });

  it("expands a leading ~ and rejects paths under $HOME outside the roots", () => {
    // The temp worktree is under os.tmpdir(), never under HOME.
    expect(() => guardPath("~/.ssh/id_ed25519", roots, worktree)).toThrow(
      pathBoundaryMessage(roots),
    );
  });

  it("confines the planner to its .ralph write root while reading the checkout", () => {
    const writeRoots = [path.join(worktree, ".ralph")];
    // read root = whole checkout: reading source is fine.
    expect(() => guardPath("src/a.ts", roots, worktree)).not.toThrow();
    // write root = .ralph only: writing an artifact is fine…
    expect(() =>
      guardPath(".ralph/PLAN.md", writeRoots, worktree),
    ).not.toThrow();
    // …but writing source is rejected (no write root in the repo body).
    expect(() => guardPath("src/a.ts", writeRoots, worktree)).toThrow(
      pathBoundaryMessage(writeRoots),
    );
  });
});

describe("isInsideOrEqual — segment comparison", () => {
  it("treats equal paths as inside", () => {
    expect(isInsideOrEqual("/a/b", "/a/b")).toBe(true);
  });
  it("treats a child as inside", () => {
    expect(isInsideOrEqual("/a/b/c", "/a/b")).toBe(true);
  });
  it("treats a prefix-sharing sibling as outside", () => {
    expect(isInsideOrEqual("/a/b-evil", "/a/b")).toBe(false);
  });
  it("treats a parent as outside", () => {
    expect(isInsideOrEqual("/a", "/a/b")).toBe(false);
  });
});

describe("realpathBestEffort", () => {
  it("resolves an existing path through symlinks", () => {
    expect(realpathBestEffort(path.join(worktree, "src"))).toBe(
      fs.realpathSync(path.join(worktree, "src")),
    );
  });
  it("resolves the deepest existing ancestor and re-appends the tail", () => {
    const got = realpathBestEffort(path.join(worktree, "src", "no", "such"));
    expect(got).toBe(
      path.join(fs.realpathSync(path.join(worktree, "src")), "no", "such"),
    );
  });
});
