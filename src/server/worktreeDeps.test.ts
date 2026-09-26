import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { provisionNodeModules } from "./worktreeDeps";

let root: string;
let repo: string;
let worktree: string;

function seedInstall(dir: string) {
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(dir, "node_modules", ".bin"));
  fs.symlinkSync("../pkg/index.js", path.join(dir, "node_modules", ".bin", "pkg"));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-worktree-deps-"));
  repo = path.join(root, "repo");
  worktree = path.join(root, "wt");
  fs.mkdirSync(repo);
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(worktree, "package-lock.json"), '{"lockfileVersion":3}\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("provisionNodeModules", () => {
  it("hard-links the checkout's install into the worktree with its symlinks intact", async () => {
    seedInstall(repo);

    await expect(provisionNodeModules(repo, worktree)).resolves.toBe("hardlinked");

    const original = fs.statSync(path.join(repo, "node_modules", "pkg", "index.js"));
    const linked = fs.statSync(path.join(worktree, "node_modules", "pkg", "index.js"));
    expect(linked.ino).toBe(original.ino);
    expect(linked.nlink).toBe(2);
    expect(fs.readlinkSync(path.join(worktree, "node_modules", ".bin", "pkg"))).toBe("../pkg/index.js");
  });

  it("skips when the lockfiles differ", async () => {
    seedInstall(repo);
    fs.writeFileSync(path.join(worktree, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');

    await expect(provisionNodeModules(repo, worktree)).resolves.toBe("skipped");
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });

  it("skips when a side has no lockfile at all", async () => {
    seedInstall(repo);
    fs.rmSync(path.join(worktree, "package-lock.json"));

    await expect(provisionNodeModules(repo, worktree)).resolves.toBe("skipped");
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });

  it("skips when the checkout has no install, or only a symlink to one", async () => {
    await expect(provisionNodeModules(repo, worktree)).resolves.toBe("skipped");

    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    seedInstall(elsewhere);
    fs.symlinkSync(path.join(elsewhere, "node_modules"), path.join(repo, "node_modules"));

    await expect(provisionNodeModules(repo, worktree)).resolves.toBe("skipped");
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });

  it("leaves a worktree that already has a node_modules alone", async () => {
    seedInstall(repo);
    fs.mkdirSync(path.join(worktree, "node_modules"));
    fs.writeFileSync(path.join(worktree, "node_modules", "marker"), "");

    await expect(provisionNodeModules(repo, worktree)).resolves.toBe("skipped");
    expect(fs.existsSync(path.join(worktree, "node_modules", "marker"))).toBe(true);
    expect(fs.existsSync(path.join(worktree, "node_modules", "pkg"))).toBe(false);
  });
});
