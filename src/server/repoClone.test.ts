import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, initScratchRepo } from "@/testUtils/gitRepo";
import { setupTestStateDir } from "@/testUtils/testDataDir";

const root = setupTestStateDir("radulf-clone-");

const { CLONES_DIR } = await import("@/db");
const { cloneRepository } = await import("./repoClone");

let source: string;
let empty: string;

beforeAll(() => {
  source = initScratchRepo("radulf-clone-src-", { branch: "trunk" });
  empty = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-clone-empty-"));
  git(empty, "init", "-b", "main");
});

afterAll(() => {
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

describe("cloneRepository", () => {
  it("clones into repos/ beside data/, names it after the URL, and reads the remote's default branch", async () => {
    const cloned = await cloneRepository(`file://${source}`, "");

    expect(CLONES_DIR).toBe(path.join(root, "repos"));
    const name = path.basename(source);
    expect(cloned).toEqual({ name, path: path.join(CLONES_DIR, name), defaultBranch: "trunk" });
    expect(git(cloned.path, "remote", "get-url", "origin")).toBe(`file://${source}`);
    expect(git(cloned.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("trunk");
    expect(git(cloned.path, "log", "--format=%s")).toBe("initial");
  });

  it("uses the requested name and refuses a second clone into the same folder", async () => {
    const cloned = await cloneRepository(`file://${source}`, "named");

    expect(cloned.path).toBe(path.join(CLONES_DIR, "named"));
    await expect(cloneRepository(`file://${source}`, "named")).rejects.toThrow(/already exists/);
  });

  it.each(["/tmp/somewhere", "ext::sh -c id", "owner/repo", "https://example.com/has space"])(
    'rejects the URL "%s"',
    async (url) => {
      await expect(cloneRepository(url, "")).rejects.toThrow(/clone URL must start with/);
    },
  );

  it("applies the repository name rule to derived and requested names", async () => {
    await expect(cloneRepository("https://example.com/acme/.hidden", "")).rejects.toThrow(/repository name/);
    await expect(cloneRepository(`file://${source}`, "-flag")).rejects.toThrow(/repository name/);
  });

  it("removes the folder when the clone fails or the remote has no commits", async () => {
    await expect(cloneRepository(`file://${source}-missing`, "gone")).rejects.toThrow(/git clone failed/);
    expect(fs.existsSync(path.join(CLONES_DIR, "gone"))).toBe(false);

    await expect(cloneRepository(`file://${empty}`, "empty")).rejects.toThrow(/no commits/);
    expect(fs.existsSync(path.join(CLONES_DIR, "empty"))).toBe(false);
  });
});
