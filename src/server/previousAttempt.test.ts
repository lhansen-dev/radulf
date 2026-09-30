import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const testDataDir = setupTestDataDir("radulf-previousAttempt-");
const { db, cards, repos, runs, now } = await import("@/db");
type RunStatus = (typeof runs.$inferInsert)["status"];
const {
  DIGEST_MAX_COMMANDS,
  DIGEST_OUTPUT_CHARS,
  SECTION_MAX_CHARS,
  attemptTranscriptPath,
  digestTranscript,
  previousFailedAttempt,
  renderDeadlineSection,
  renderPreviousAttemptSection,
} = await import("./previousAttempt");

const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const toolCall = (command: string) => line({ t: "tool", name: "bash", input: { command } });
const toolEnd = (text: string, isError = false) =>
  line({
    t: "raw",
    event: { type: "tool_execution_end", toolCallId: "x", toolName: "bash", result: { content: [{ type: "text", text }] }, isError },
  });

function writeTranscript(content: string): string {
  const file = path.join(fs.mkdtempSync(path.join(testDataDir, "transcript-")), "evaluate.jsonl");
  fs.writeFileSync(file, content);
  return file;
}

const attempt = {
  runId: "run-prev",
  kind: "evaluate" as const,
  status: "timeout",
  exitReason: "evaluation timed out",
  startedAt: "2026-09-23T20:43:10.000Z",
  endedAt: "2026-09-23T20:53:10.000Z",
};

describe("digestTranscript", () => {
  it("pairs each tool call with the raw tool_execution_end that follows it, in order", () => {
    const file = writeTranscript(
      toolCall("make build-worker") +
        toolEnd("bundle built\nEXIT=0") +
        line({ t: "text", role: "assistant", content: "Bundle is fine, running the suite." }) +
        toolCall("make test") +
        toolEnd("23 failed | 1154 passed", true) +
        line({ t: "usage", inputTokens: 1, outputTokens: 1 }) +
        "not json\n",
    );
    const digest = digestTranscript(file);
    expect(digest.toolCalls).toBe(2);
    expect(digest.commands).toEqual([
      { name: "bash", summary: "make build-worker", output: "bundle built\nEXIT=0", isError: false },
      { name: "bash", summary: "make test", output: "23 failed | 1154 passed", isError: true },
    ]);
    expect(digest.lastText).toBe("Bundle is fine, running the suite.");
  });

  it("keeps the tail of a long output and the last commands of a long run", () => {
    let content = "";
    for (let i = 1; i <= DIGEST_MAX_COMMANDS + 5; i++) {
      content += toolCall(`step ${i}`) + toolEnd(`${"x".repeat(2_000)}END${i}`);
    }
    const digest = digestTranscript(writeTranscript(content));
    expect(digest.toolCalls).toBe(DIGEST_MAX_COMMANDS + 5);
    expect(digest.commands).toHaveLength(DIGEST_MAX_COMMANDS);
    expect(digest.commands[0].summary).toBe("step 6");
    const last = digest.commands.at(-1)!;
    expect(last.output.endsWith(`END${DIGEST_MAX_COMMANDS + 5}`)).toBe(true);
    expect(last.output.length).toBeLessThanOrEqual(DIGEST_OUTPUT_CHARS + 1);
    expect(last.output.startsWith("…")).toBe(true);
  });

  it("gives an empty digest for a transcript that is not there", () => {
    expect(digestTranscript(path.join(testDataDir, "missing.jsonl"))).toEqual({
      lastText: "",
      commands: [],
      toolCalls: 0,
    });
  });
});

describe("renderPreviousAttemptSection", () => {
  it("names the ending, the elapsed time, the notes, the last words, and the commands", () => {
    const section = renderPreviousAttemptSection({
      stage: "evaluator",
      attempt,
      digest: {
        lastText: "Chasing the suite failures.",
        toolCalls: 3,
        commands: [{ name: "bash", summary: "make test", output: "23 failed", isError: true }],
      },
      notes: "- make check-split: PASS\n- make test: 23 failures, all /tmp\n",
    });
    expect(section).toContain("PREVIOUS ATTEMPT OF THIS STAGE");
    expect(section).toContain("ended with: evaluation timed out after 10 minutes.");
    expect(section).toContain("It made 3 tool calls.");
    expect(section).toContain("- make check-split: PASS");
    expect(section).toContain("Its last words:\nChasing the suite failures.");
    expect(section).toContain("(2 earlier commands omitted)");
    expect(section).toContain("3. bash: make test  [error]\n     23 failed");
  });

  it("forwards a planner's drafts and copes with no transcript at all", () => {
    const section = renderPreviousAttemptSection({
      stage: "planner",
      attempt: { ...attempt, kind: "plan", exitReason: null, endedAt: null },
      digest: { lastText: "", commands: [], toolCalls: 0 },
      drafts: { "PLAN.md": "## Tasks\n- [ ] first\n", "CRITERIA.md": "", "PROMPT.md": "Do it." },
    });
    expect(section).toContain("The last planner attempt on this card ended with: timeout.");
    expect(section).toContain("Its draft .ralph/PLAN.md, incomplete and unverified:\n## Tasks\n- [ ] first");
    expect(section).not.toContain("draft .ralph/CRITERIA.md");
    expect(section).toContain("(the transcript records no tool calls)");
  });

  it("drops the oldest commands until the section fits its ceiling", () => {
    const commands = Array.from({ length: DIGEST_MAX_COMMANDS }, (_, i) => ({
      name: "bash",
      summary: `command ${i}`,
      output: "y".repeat(DIGEST_OUTPUT_CHARS * 2),
      isError: false,
    }));
    const section = renderPreviousAttemptSection({
      stage: "evaluator",
      attempt,
      digest: { lastText: "", commands, toolCalls: commands.length },
    });
    expect(section.length).toBeLessThanOrEqual(SECTION_MAX_CHARS);
    expect(section).toContain(`command ${DIGEST_MAX_COMMANDS - 1}`);
    expect(section).not.toContain("command 0\n");
  });
});

describe("renderDeadlineSection", () => {
  it("states the start, the budget, the kill time, and the seventy percent target", () => {
    const started = new Date("2026-09-23T21:00:00.000Z");
    const section = renderDeadlineSection("evaluator", started, 10 * 60_000);
    expect(section).toContain("started at 2026-09-23T21:00:00.000Z");
    expect(section).toContain("hard budget is 10 minutes");
    expect(section).toContain("at 2026-09-23T21:10:00.000Z it is killed");
    expect(section).toContain("your verdict in `.ralph/EVALUATION.md` written by 2026-09-23T21:07:00.000Z");
    expect(renderDeadlineSection("planner", started, 60_000)).toContain("the three plan artifacts in `.ralph/`");
  });
});

describe("previousFailedAttempt", () => {
  beforeEach(() => {
    db.insert(repos).values({ id: "r", name: "r", path: "/tmp/r", defaultBranch: "main", createdAt: now() }).run();
    db.insert(cards)
      .values({ id: "c", repoId: "r", title: "c", description: "", status: "evaluating", position: 1, createdAt: now(), updatedAt: now() })
      .run();
  });
  afterEach(() => {
    db.delete(runs).run();
    db.delete(cards).run();
    db.delete(repos).run();
  });

  function seedRuns(runRows: { id: string; kind: "plan" | "loop" | "evaluate"; status: RunStatus; startedAt: string; exitReason?: string }[]) {
    for (const row of runRows) {
      db.insert(runs)
        .values({ ...row, cardId: "c", worktreePath: "/tmp/wt", branch: "b", endedAt: row.startedAt })
        .run();
    }
  }

  it("returns the latest run when it is a failed attempt of the same stage", () => {
    seedRuns([
      { id: "loop", kind: "loop", status: "completed", startedAt: "2026-09-23T10:00:00.000Z" },
      { id: "ev1", kind: "evaluate", status: "timeout", startedAt: "2026-09-23T10:10:00.000Z", exitReason: "evaluation timed out" },
    ]);
    expect(previousFailedAttempt("c", "evaluate")).toMatchObject({ runId: "ev1", status: "timeout", exitReason: "evaluation timed out" });
    expect(attemptTranscriptPath(previousFailedAttempt("c", "evaluate")!)).toMatch(/ev1[/\\]evaluate\.jsonl$/);
  });

  it("returns null for a fresh cycle after a loop, a completed run, or the other stage", () => {
    seedRuns([
      { id: "ev1", kind: "evaluate", status: "timeout", startedAt: "2026-09-23T10:10:00.000Z" },
      { id: "loop", kind: "loop", status: "completed", startedAt: "2026-09-23T10:20:00.000Z" },
    ]);
    expect(previousFailedAttempt("c", "evaluate")).toBeNull();
    db.delete(runs).run();
    seedRuns([{ id: "ev2", kind: "evaluate", status: "completed", startedAt: "2026-09-23T10:30:00.000Z" }]);
    expect(previousFailedAttempt("c", "evaluate")).toBeNull();
    db.delete(runs).run();
    seedRuns([{ id: "plan1", kind: "plan", status: "failed", startedAt: "2026-09-23T10:40:00.000Z" }]);
    expect(previousFailedAttempt("c", "evaluate")).toBeNull();
    expect(previousFailedAttempt("c", "plan")).toMatchObject({ runId: "plan1", kind: "plan" });
  });
});
