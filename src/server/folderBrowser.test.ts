import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browsableRoot, listFolder } from "./folderBrowser";

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "radulf-browse-root-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "radulf-browse-out-")));

  fs.mkdirSync(path.join(root, "projects/a-repo/.git"), { recursive: true });
  fs.mkdirSync(path.join(root, "projects/plain-folder"), { recursive: true });
  // A linked worktree carries a .git FILE, not a directory.
  fs.mkdirSync(path.join(root, "projects/linked-worktree"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects/linked-worktree/.git"), "gitdir: /elsewhere\n");
  fs.mkdirSync(path.join(root, ".hidden-dir"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects/a-file.txt"), "not a folder");
  fs.writeFileSync(path.join(outside, "secret.txt"), "should never be listed");
  // A symlink inside the root pointing out of it: the classic escape.
  fs.symlinkSync(outside, path.join(root, "escape-hatch"), "dir");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("browsableRoot", () => {
  it("falls back to the home directory when unset", () => {
    expect(browsableRoot("")).toBe(fs.realpathSync(os.homedir()));
    expect(browsableRoot("   ")).toBe(fs.realpathSync(os.homedir()));
  });

  it("resolves a configured root through symlinks", () => {
    expect(browsableRoot(root)).toBe(root);
  });
});

describe("listFolder", () => {
  it("lists directories only, skipping files and hidden entries", () => {
    const listing = listFolder(null, root);
    const names = listing.entries.map((e) => e.name);
    expect(names).toContain("projects");
    expect(names).not.toContain(".hidden-dir");
    const projects = listFolder(path.join(root, "projects"), root);
    expect(projects.entries.map((e) => e.name)).not.toContain("a-file.txt");
  });

  it("flags a git repository, including a linked worktree's .git file", () => {
    const listing = listFolder(path.join(root, "projects"), root);
    const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e.isGitRepo]));
    expect(byName["a-repo"]).toBe(true);
    expect(byName["linked-worktree"]).toBe(true);
    expect(byName["plain-folder"]).toBe(false);
  });

  it("sorts entries by name", () => {
    const names = listFolder(path.join(root, "projects"), root).entries.map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("has no parent at the root, and one below it", () => {
    expect(listFolder(null, root).parent).toBeNull();
    expect(listFolder(path.join(root, "projects"), root).parent).toBe(root);
  });

  it("refuses a path outside the root", () => {
    expect(() => listFolder(outside, root)).toThrow(/outside the browsable root/);
    expect(() => listFolder("/etc", root)).toThrow(/outside the browsable root/);
    expect(() => listFolder(path.join(root, "..", ".."), root)).toThrow(/outside the browsable root/);
  });

  it("refuses a symlink that leaves the root, rather than following it", () => {
    // The entry is reachable by name, so the guard must resolve it rather than
    // trust that it sits under the root by path alone.
    expect(() => listFolder(path.join(root, "escape-hatch"), root)).toThrow(
      /outside the browsable root/,
    );
  });

  it("reports a missing or non-directory path without leaking a stack", () => {
    expect(() => listFolder(path.join(root, "nope"), root)).toThrow(/does not exist/);
    expect(() => listFolder(path.join(root, "projects/a-file.txt"), root)).toThrow(
      /is not a folder/,
    );
  });

  it("truncates a very large directory and says so", () => {
    const big = path.join(root, "big");
    fs.mkdirSync(big, { recursive: true });
    for (let i = 0; i < 505; i++) fs.mkdirSync(path.join(big, `d${String(i).padStart(4, "0")}`));
    const listing = listFolder(big, root);
    expect(listing.entries).toHaveLength(500);
    expect(listing.truncated).toBe(true);
    fs.rmSync(big, { recursive: true, force: true });
  });
});
