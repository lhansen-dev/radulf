import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildLoopPrompt,
  buildProgressState,
  captureIterationState,
  deterministicCommitMessage,
  hasIterationWorkProduct,
  performDoneBookkeeping,
  performIterationBookkeeping,
  readIterationDone,
  taskInjectionBlock,
} from "./bookkeeping";
import { tryGit } from "./git";

const PLAN = "## Tasks\n- [ ] item 1\n- [ ] item 2\n";

// One committed repo (PLAN.md only), copied per test — far cheaper than
// re-running git init/config/add/commit for every case.
let template: string;
const dirs: string[] = [];

beforeAll(async () => {
  template = fs.mkdtempSync("/tmp/ralph-test-template-");
  await tryGit(template, "init");
  await tryGit(template, "config", "user.email", "test@test.com");
  await tryGit(template, "config", "user.name", "Test");
  fs.writeFileSync(path.join(template, "PLAN.md"), PLAN);
  await tryGit(template, "add", "-A");
  await tryGit(template, "commit", "-m", "initial");
});

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(template, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync("/tmp/ralph-test-");
  dirs.push(dir);
  return dir;
}

/** A fresh copy of the template repo, optionally with a different PLAN.md. */
async function initRepo(planMd?: string): Promise<string> {
  const dir = tmpDir();
  fs.cpSync(template, dir, { recursive: true });
  if (planMd !== undefined) {
    fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
    await tryGit(dir, "commit", "-am", "plan");
  }
  return dir;
}

const git = async (dir: string, ...args: string[]) => (await tryGit(dir, ...args)).out;
const commitCount = async (dir: string) =>
  (await git(dir, "log", "--oneline")).split("\n").filter(Boolean).length;
const bookkeepingOpts = (dir: string) => ({
  ralphDir: dir,
  worktreePath: dir,
  planPath: path.join(dir, "PLAN.md"),
});

describe("deterministicCommitMessage", () => {
  it("formats the task number and summary verbatim", () => {
    expect(deterministicCommitMessage(1, "implemented the thing")).toBe(
      "ralph: task 1 — implemented the thing",
    );
    // A pure format, not a validator: no trimming, no special cases.
    expect(deterministicCommitMessage(0, "")).toBe("ralph: task 0 — ");
    expect(deterministicCommitMessage(3, "  edge — case \n")).toBe("ralph: task 3 —   edge — case \n");
  });
});

describe("buildLoopPrompt", () => {
  it("prepends a block for the first unchecked task to the original prompt", () => {
    const planMd = "## Tasks\n- [ ] implement the widget\n- [ ] test the widget\n";
    const original = "# Original prompt\n";
    const block = taskInjectionBlock(planMd);

    expect(buildLoopPrompt(original, planMd)).toBe(`${block}\n\n${original}`);
    expect(block).toContain("Task #1:");
    expect(block).toContain("implement the widget");
    expect(block).toContain("LAST_TASK=false");
    expect(block).toContain("This is your ONLY task");
    expect(block).toContain("Run only the targeted check named in");
    // The honest way out of a task the loop cannot do, so it is never faked.
    expect(block).toContain(".ralph/BLOCKED");
    // Both files are orchestrator-private: the loop cannot access them.
    expect(block).not.toContain("PLAN.md");
    expect(block).not.toContain("CRITERIA.md");
  });

  it("preserves multiline item text verbatim", () => {
    const planMd =
      "## Tasks\n- [ ] implement the widget\n  handle edge cases\n  and retries\n- [ ] test it\n";
    expect(taskInjectionBlock(planMd)).toContain("implement the widget\nhandle edge cases\nand retries");
  });

  it.each([
    ["## Tasks\n- [x] done item\n- [ ] last item\n", "Task #2:"],
    ["## Tasks\n- [ ] the only item\n", "Task #1:"],
  ])("sets LAST_TASK=true when the selected item is the last unchecked one", (planMd, taskLabel) => {
    const block = taskInjectionBlock(planMd);
    expect(block).toContain(taskLabel);
    expect(block).toContain("LAST_TASK=true");
  });

  it.each([
    ["an empty plan", ""],
    ["no ## Tasks heading", "# Other content\n\n- [ ] orphan item\n"],
    ["every item checked", "## Tasks\n- [x] done\n- [x] also done\n"],
  ])("throws on %s — an uninjectable plan is a caller bug", (_label, planMd) => {
    expect(() => buildLoopPrompt("# Original prompt\n", planMd)).toThrow(/no unchecked task/);
  });
});

describe("readIterationDone", () => {
  it("returns the trimmed signal, or null when missing or blank", () => {
    const dir = tmpDir();
    const signal = path.join(dir, "ITERATION_DONE");
    expect(readIterationDone(dir)).toBeNull();
    fs.writeFileSync(signal, "   \n  \n  ");
    expect(readIterationDone(dir)).toBeNull();
    fs.writeFileSync(signal, "  completed the task  ");
    expect(readIterationDone(dir)).toBe("completed the task");
  });
});

describe("buildProgressState", () => {
  it("is HEAD, an empty dirty section, and the checklist for a clean worktree", async () => {
    const dir = await initRepo();
    const head = await git(dir, "rev-parse", "HEAD");
    expect(await buildProgressState(dir, path.join(dir, "PLAN.md"))).toBe(`${head}\n\n${PLAN}`);
    expect(await buildProgressState(dir, path.join(dir, "missing.md"))).toBe(`${head}\n\n`);
  });

  it("places dirty status between HEAD and the checklist", async () => {
    const dir = await initRepo();
    const head = await git(dir, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(dir, "newfile.txt"), "dirty");

    const state = await buildProgressState(dir, path.join(dir, "PLAN.md"));
    expect(state.indexOf(head)).toBe(0);
    expect(state.indexOf("newfile.txt")).toBeGreaterThan(0);
    expect(state.lastIndexOf(PLAN)).toBeGreaterThan(state.indexOf("newfile.txt"));
  });

  it("changes on any edit or commit, and only then", async () => {
    const dir = await initRepo();
    const planPath = path.join(dir, "missing-plan.md");
    const states = [await buildProgressState(dir, planPath)];
    const next = async () => {
      const state = await buildProgressState(dir, planPath);
      expect(states).not.toContain(state);
      states.push(state);
    };

    // An untouched dirty worktree reads identically: the stall signal.
    fs.writeFileSync(path.join(dir, "draft.ts"), "v1");
    await next();
    expect(await buildProgressState(dir, planPath)).toBe(states.at(-1));

    // Porcelain lists only paths, so re-edits must show through the content hash.
    fs.writeFileSync(path.join(dir, "draft.ts"), "v2");
    await next();
    fs.writeFileSync(path.join(dir, "PLAN.md"), "edited once");
    await next();
    fs.writeFileSync(path.join(dir, "PLAN.md"), "edited twice");
    await next();

    await tryGit(dir, "add", "-A");
    await tryGit(dir, "commit", "-m", "progress");
    await next();
  });
});

describe("hasIterationWorkProduct", () => {
  it("ignores the signal file but sees any other edit", async () => {
    const dir = await initRepo();
    const pre = await captureIterationState(dir);
    expect(await hasIterationWorkProduct(dir, pre)).toBe(false);

    fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "did the thing");
    expect(await hasIterationWorkProduct(dir, pre)).toBe(false);

    fs.writeFileSync(path.join(dir, "feature.ts"), "export const x = 1;");
    expect(await hasIterationWorkProduct(dir, pre)).toBe(true);
  });

  it("sees a new commit even with a clean worktree", async () => {
    const dir = await initRepo();
    const pre = await captureIterationState(dir);
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const x = 1;");
    await tryGit(dir, "add", "-A");
    await tryGit(dir, "commit", "-m", "agent committed despite the rules");
    expect(await hasIterationWorkProduct(dir, pre)).toBe(true);
  });

  it("credits uncommitted work that predates the iteration", async () => {
    const dir = await initRepo();
    // An earlier iteration edited a file and then failed before signalling.
    // Only loop agents leave a worktree dirty — every other writer commits —
    // so this is creditable work even though nothing changed during this one.
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const x = 1;");
    const pre = await captureIterationState(dir);
    fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "verified the existing edit");
    expect(await hasIterationWorkProduct(dir, pre)).toBe(true);
  });
});

describe("performIterationBookkeeping", () => {
  it("returns null and changes nothing without a signal file", async () => {
    const dir = await initRepo();
    expect(await performIterationBookkeeping(bookkeepingOpts(dir))).toBeNull();
    expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf8")).toBe(PLAN);
    expect(await commitCount(dir)).toBe(1);
  });

  it("checks off each task, removes the signal, and commits deterministically", async () => {
    const dir = await initRepo();
    const signal = path.join(dir, "ITERATION_DONE");

    const pre = await captureIterationState(dir);
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const x = 1;");
    fs.writeFileSync(signal, "implemented the first feature");
    expect(await performIterationBookkeeping({ ...bookkeepingOpts(dir), pre })).toEqual({
      advanced: true,
      isLast: false,
      taskNumber: 1,
      summary: "implemented the first feature",
    });
    expect(fs.existsSync(signal)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf8")).toContain("- [x] item 1\n- [ ] item 2");
    expect(await git(dir, "log", "-1", "--format=%s")).toBe(
      "ralph: task 1 — implemented the first feature",
    );

    // Without a pre snapshot the signal alone is credited (legacy behavior).
    fs.writeFileSync(signal, "last item done");
    expect(await performIterationBookkeeping(bookkeepingOpts(dir))).toMatchObject({
      advanced: true,
      isLast: true,
      taskNumber: 2,
    });
    expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf8")).toContain("- [x] item 2");
  });

  it("returns null but still removes the signal when no task is unchecked", async () => {
    const dir = await initRepo("## Tasks\n- [x] item 1\n");
    fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "done but nothing to check");

    expect(await performIterationBookkeeping(bookkeepingOpts(dir))).toBeNull();
    expect(fs.existsSync(path.join(dir, "ITERATION_DONE"))).toBe(false);
    expect(await commitCount(dir)).toBe(2);
  });

  it("rejects a phantom completion: signal removed, checklist not advanced, no commit", async () => {
    const dir = await initRepo();
    const pre = await captureIterationState(dir);
    fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "claims item 1 is done");

    expect(await performIterationBookkeeping({ ...bookkeepingOpts(dir), pre })).toEqual({
      advanced: false,
      phantom: true,
      taskNumber: 1,
      summary: "claims item 1 is done",
    });
    expect(fs.existsSync(path.join(dir, "ITERATION_DONE"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf8")).toBe(PLAN);
    expect(await commitCount(dir)).toBe(1);
  });

  it("commits work a failed iteration left behind when the next one only signals", async () => {
    const dir = await initRepo();
    // The private plan lives outside the worktree, as in production.
    const planPath = path.join(tmpDir(), "PLAN.md");
    fs.writeFileSync(planPath, "## Tasks\n- [x] item 1\n- [ ] item 2\n- [ ] item 3\n");
    const ralphDir = path.join(dir, ".ralph");
    fs.mkdirSync(ralphDir);
    fs.writeFileSync(path.join(ralphDir, "PROMPT.md"), "prompt");
    await tryGit(dir, "add", "-A");
    await tryGit(dir, "commit", "-m", "plan");

    // Iteration A implements item 2, then the harness errors out before the
    // agent writes ITERATION_DONE — no bookkeeping runs.
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const x = 1;");

    // Iteration B finds the work done, verifies it, and only signals.
    const pre = await captureIterationState(dir);
    fs.writeFileSync(path.join(ralphDir, "ITERATION_DONE"), "item 2 verified");

    const result = await performIterationBookkeeping({ ralphDir, worktreePath: dir, planPath, pre });

    expect(result).toMatchObject({ advanced: true, taskNumber: 2 });
    expect(fs.readFileSync(planPath, "utf8")).toContain("- [x] item 2");
    expect(await git(dir, "log", "-1", "--format=%s")).toBe("ralph: task 2 — item 2 verified");
    expect(await git(dir, "status", "--porcelain")).toBe("");
  });
});

describe("performDoneBookkeeping", () => {
  it("returns null and changes nothing without a DONE file", async () => {
    const dir = await initRepo();
    expect(await performDoneBookkeeping(bookkeepingOpts(dir))).toBeNull();
    expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf8")).toBe(PLAN);
    expect(await commitCount(dir)).toBe(1);
  });

  it.each(["DONE", "DONE.md"])(
    "checks off the first unchecked task using the first line of %s as the summary",
    async (name) => {
      const dir = await initRepo();
      fs.writeFileSync(path.join(dir, name), "TLDR: implemented it\n- bullet 1\n- bullet 2\n");

      expect(await performDoneBookkeeping(bookkeepingOpts(dir))).toEqual({
        taskNumber: 1,
        summary: "TLDR: implemented it",
      });
      expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf8")).toContain("- [x] item 1\n- [ ] item 2");
      expect(await git(dir, "log", "-1", "--format=%s")).toBe("ralph: task 1 — TLDR: implemented it");
    },
  );

  it("returns task 0 without committing when every task is already checked", async () => {
    const dir = await initRepo("## Tasks\n- [x] item 1\n");
    fs.writeFileSync(path.join(dir, "DONE"), "all done");

    expect(await performDoneBookkeeping(bookkeepingOpts(dir))).toEqual({ taskNumber: 0, summary: "all done" });
    expect(await commitCount(dir)).toBe(2);
  });
});
