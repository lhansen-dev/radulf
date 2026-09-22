import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initScratchRepo } from "@/testUtils/gitRepo";

const mocks = vi.hoisted(() => ({ runHarness: vi.fn() }));
// vi.mock factories run before any top-level `beforeAll`, so the directories
// can't be created yet — expose them as getters over a hoisted, mutable
// object that `beforeAll` fills in once real fs/os/path imports are usable.
const dirs = vi.hoisted(() => ({ worktreesDir: "", transcriptsDir: "" }));

vi.mock("./harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harness")>()),
  runHarness: mocks.runHarness,
}));
vi.mock("@/db", () => ({
  get WORKTREES_DIR() {
    return dirs.worktreesDir;
  },
  get TRANSCRIPTS_DIR() {
    return dirs.transcriptsDir;
  },
}));

import { parseProposals, proposeOneImprovement, renderImprovePrompt } from "./improvementProposer";

function leakedWorktrees(): string[] {
  return fs.readdirSync(dirs.worktreesDir).filter((n) => n.startsWith("improve-proposer-"));
}

describe("renderImprovePrompt", () => {
  const noFocus = "(none — use your own judgment about what is most valuable to improve next.)";

  it("substitutes existing cards and the focus, with placeholders when either is absent or blank", () => {
    const template = "{{EXISTING_CARDS}} / {{FOCUS}}";
    expect(renderImprovePrompt(["A"], template, "Speed up tests")).toBe("- A / Speed up tests");
    expect(renderImprovePrompt([], template, undefined)).toBe(`- (none) / ${noFocus}`);
    expect(renderImprovePrompt([], "{{FOCUS}}", "   ")).toBe(noFocus);
  });

  it("lists every prior title as a bullet", () => {
    expect(renderImprovePrompt(["First card", "Second card"], "Open work:\n{{EXISTING_CARDS}}")).toBe(
      "Open work:\n- First card\n- Second card",
    );
  });
});

describe("parseProposals", () => {
  const one = (title: string) =>
    `[{"title": ${JSON.stringify(title)}, "description": "d", "rationale": "r"}]`;

  it.each([
    ["a bare JSON array", one("A")],
    ["a fenced array", "```json\n" + one("A") + "\n```"],
    ["an array with prose on both sides and no fence", `Here you go: ${one("A")} — hope that helps.`],
  ])("parses %s", (_label, text) => {
    expect(parseProposals(text)).toEqual([{ title: "A", description: "d", rationale: "r" }]);
  });

  // Regression: an observed live Improvement Run lost this exact shape — a
  // sentence of preamble before the fenced array — and the run went on to end
  // "proposer ran dry" having created zero cards.
  it("parses an array preceded by prose the model was told not to emit", () => {
    const text =
      "Based on my review, I found a clear gap: `pm.ts` exports a helper that " +
      "has no direct tests.\n\n```json\n" +
      one("Add a parseProposals unit test suite") +
      "\n```";
    expect(parseProposals(text)).toEqual([
      {
        title: "Add a parseProposals unit test suite",
        description: "d",
        rationale: "r",
      },
    ]);
  });

  // Regression: the same live pass wrote ```json *inside* a description
  // string, which closes a lazy fence match early. The outermost bracket span
  // is the fallback that survives it.
  it("recovers when a description contains a code fence of its own", () => {
    const text =
      "Here is my proposal.\n\n```json\n" +
      `[{"title":"A","description":"strips leading/trailing \\u0060\\u0060\\u0060json fences before parsing","rationale":"r"}]` +
      "\n```";
    expect(parseProposals(text)).toEqual([
      {
        title: "A",
        description: "strips leading/trailing ```json fences before parsing",
        rationale: "r",
      },
    ]);
  });

  it("prefers a fenced array over bracket text elsewhere in the prose", () => {
    const text = `I considered [a, b, c] first.\n\n\`\`\`json\n${one("Chosen")}\n\`\`\``;
    expect(parseProposals(text)[0]?.title).toBe("Chosen");
  });

  it("coerces a missing rationale and drops empty-field items", () => {
    const text = `[{"title":"A","description":"d"},{"title":"","description":"d"},{"title":"B"}]`;
    expect(parseProposals(text)).toEqual([{ title: "A", description: "d", rationale: "" }]);
  });

  it("caps the result at 3", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      title: `t${i}`,
      description: "d",
      rationale: "r",
    }));
    expect(parseProposals(JSON.stringify(items))).toHaveLength(3);
  });

  it("returns [] for prose with no array, non-array JSON, and malformed input", () => {
    expect(parseProposals("I have nothing to propose.")).toEqual([]);
    expect(parseProposals(`{"title":"A","description":"d"}`)).toEqual([]);
    expect(parseProposals("```json\n[{title: broken]\n```")).toEqual([]);
    expect(parseProposals("")).toEqual([]);
  });
});

describe("proposeOneImprovement", () => {
  let repoPath: string;
  const baseInput = () => ({
    repo: { path: repoPath },
    featureBranch: "main",
    priorTitles: [] as string[],
    plannerProvider: "anthropic" as const,
    plannerModel: "planner-model",
    plannerReasoningLevel: "medium",
    template: "T:\n{{EXISTING_CARDS}}\nF:{{FOCUS}}",
  });

  beforeAll(() => {
    dirs.worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-improve-worktrees-"));
    dirs.transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-improve-transcripts-"));
    repoPath = initScratchRepo("ralph-improve-repo-");
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
