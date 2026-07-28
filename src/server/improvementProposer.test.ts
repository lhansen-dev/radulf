import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runHarness: vi.fn() }));
// vi.mock factories run before any top-level `beforeAll`, so the directories
// can't be created yet — expose them as getters over a hoisted, mutable
// object that `beforeAll` fills in once real fs/os/path imports are usable.
const dirs = vi.hoisted(() => ({ worktreesDir: "", transcriptsDir: "" }));

vi.mock("./harness", () => ({ runHarness: mocks.runHarness }));
vi.mock("@/db", () => ({
  get WORKTREES_DIR() {
    return dirs.worktreesDir;
  },
  get TRANSCRIPTS_DIR() {
    return dirs.transcriptsDir;
  },
}));

import { proposeOneImprovement, renderImprovePrompt } from "./improvementProposer";
import type { Settings } from "./settings";

function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function leakedWorktrees(): string[] {
  return fs.readdirSync(dirs.worktreesDir).filter((n) => n.startsWith("improve-proposer-"));
}

describe("renderImprovePrompt", () => {
  it("substitutes existing cards and an explicit focus", () => {
    expect(renderImprovePrompt(["A"], "{{EXISTING_CARDS}} / {{FOCUS}}", "Speed up tests")).toBe(
      "- A / Speed up tests"
    );
  });

  it("renders the none-yet card placeholder and a neutral focus fallback when both are absent", () => {
    expect(renderImprovePrompt([], "{{EXISTING_CARDS}} / {{FOCUS}}", undefined)).toBe(
      "- (none) / (none — use your own judgment about what is most valuable to improve next.)"
    );
  });

  it("treats a blank/whitespace-only focus the same as no focus", () => {
    expect(renderImprovePrompt([], "{{FOCUS}}", "   ")).toBe(
      "(none — use your own judgment about what is most valuable to improve next.)"
    );
  });
});

describe("proposeOneImprovement", () => {
  let repoPath: string;
  const baseSettings = { improvePromptTemplate: "T:\n{{EXISTING_CARDS}}\nF:{{FOCUS}}" } as Settings;
  const baseInput = () => ({
    repo: { path: repoPath },
    featureBranch: "main",
    priorTitles: [] as string[],
    plannerProvider: "anthropic" as const,
    plannerModel: "planner-model",
    plannerReasoningLevel: "medium",
    s: baseSettings,
  });

  beforeAll(() => {
    dirs.worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-improve-worktrees-"));
    dirs.transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-improve-transcripts-"));
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-improve-repo-"));
    git(repoPath, "init", "-b", "main");
    git(repoPath, "config", "user.email", "test@test.com");
    git(repoPath, "config", "user.name", "Test");
    fs.writeFileSync(path.join(repoPath, "README.md"), "# test");
    git(repoPath, "add", ".");
    git(repoPath, "commit", "-m", "initial");
  });

  afterAll(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.rmSync(dirs.worktreesDir, { recursive: true, force: true });
    fs.rmSync(dirs.transcriptsDir, { recursive: true, force: true });
  });

  afterEach(() => {
    mocks.runHarness.mockReset();
  });

  it("returns the planner's top proposal and leaves no worktree behind", async () => {
    mocks.runHarness.mockResolvedValue({
      timedOut: false,
      error: undefined,
      code: 0,
      lastText: JSON.stringify([{ title: "Do X", description: "desc", rationale: "why" }]),
    });

    const result = await proposeOneImprovement(baseInput());

    expect(result).toEqual({ title: "Do X", description: "desc", rationale: "why" });
    expect(mocks.runHarness).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: expect.stringContaining(dirs.worktreesDir), readOnly: true })
    );
    expect(leakedWorktrees()).toEqual([]);
  });

  it("returns null on garbage planner output and leaves no worktree behind", async () => {
    mocks.runHarness.mockResolvedValue({
      timedOut: false,
      error: undefined,
      code: 0,
      lastText: "not json at all",
    });

    const result = await proposeOneImprovement(baseInput());

    expect(result).toBeNull();
    expect(leakedWorktrees()).toEqual([]);
  });

  it("returns null when the harness times out or errors", async () => {
    mocks.runHarness.mockResolvedValue({ timedOut: true, error: undefined, code: null, lastText: "" });
    expect(await proposeOneImprovement(baseInput())).toBeNull();

    mocks.runHarness.mockResolvedValue({ timedOut: false, error: "boom", code: null, lastText: "" });
    expect(await proposeOneImprovement(baseInput())).toBeNull();

    expect(leakedWorktrees()).toEqual([]);
  });

  it("cleans up the ephemeral worktree even when the harness throws", async () => {
    mocks.runHarness.mockRejectedValue(new Error("harness exploded"));

    await expect(proposeOneImprovement(baseInput())).rejects.toThrow("harness exploded");
    expect(leakedWorktrees()).toEqual([]);
  });
});
