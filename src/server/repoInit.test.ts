import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initRepository } from "./repoInit";

function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "radulf-init-root-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "radulf-init-out-")));
  fs.mkdirSync(path.join(root, "existing"));
  fs.mkdirSync(path.join(root, "checkout"));
  git(path.join(root, "checkout"), "init");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("initRepository", () => {
  it("creates a repository on main with a README and one commit", async () => {
    const created = await initRepository(root, "fresh-project", root);

    expect(created).toEqual({ path: path.join(root, "fresh-project"), defaultBranch: "main" });
    expect(git(created.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(created.path, "log", "--format=%s")).toBe("chore: initial commit");
    expect(git(created.path, "ls-files")).toBe("README.md");
    expect(fs.readFileSync(path.join(created.path, "README.md"), "utf8")).toBe("# fresh-project\n");
    expect(git(created.path, "status", "--porcelain")).toBe("");
  });

  it.each(["", ".hidden", "a/b", "../escape", "-flag", "has space"])('rejects the name "%s"', async (name) => {
    await expect(initRepository(root, name, root)).rejects.toThrow(/repository name/);
  });

  it("refuses a parent outside the browsable root", async () => {
    await expect(initRepository(outside, "escapee", root)).rejects.toThrow(/outside the browsable root/);
    expect(fs.existsSync(path.join(outside, "escapee"))).toBe(false);
  });

  it("refuses a missing parent, an existing target, and a parent inside a checkout", async () => {
    await expect(initRepository(path.join(root, "nope"), "x", root)).rejects.toThrow(/does not exist/);
    await expect(initRepository(root, "existing", root)).rejects.toThrow(/already exists/);
    await expect(initRepository(path.join(root, "checkout"), "x", root)).rejects.toThrow(
      /already inside a git repository/,
    );
    expect(fs.existsSync(path.join(root, "checkout", "x"))).toBe(false);
  });
});
