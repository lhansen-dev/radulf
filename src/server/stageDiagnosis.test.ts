import { describe, expect, it } from "vitest";
import { diagnosisMessage, misconfiguredStage, type DiagnosisRun } from "./stageDiagnosis";

/** Runs are given newest-last, as a card's history reads. */
function history(...rows: Partial<DiagnosisRun>[]): DiagnosisRun[] {
  return rows.map((row, i) => ({
    kind: "evaluate",
    status: "failed",
    provider: "omlx",
    model: "llm",
    startedAt: `2026-09-20T1${i}:00:00.000Z`,
    ...row,
  }));
}

describe("misconfiguredStage", () => {
  it("says nothing about two failures", () => {
    expect(misconfiguredStage(history({}, {}), "evaluate")).toBeNull();
  });

  it("names the pairing after three", () => {
    // The shape of the real thing: one stuck run and two timeouts, all on the
    // same local model, none of which said anything on its own.
    expect(
      misconfiguredStage(
        history({ status: "failed" }, { status: "timeout" }, { status: "timeout" }),
        "evaluate",
      ),
    ).toEqual({ kind: "evaluate", provider: "omlx", model: "llm", attempts: 3 });
  });

  it("starts over when the model changes, so switching clears the reading", () => {
    expect(
      misconfiguredStage(
        history({}, {}, { provider: "chatgpt", model: "gpt-6-astra" }),
        "evaluate",
      ),
    ).toBeNull();
  });

  it("starts over after a run that completed", () => {
    expect(
      misconfiguredStage(history({}, {}, { status: "completed" }, {}), "evaluate"),
    ).toBeNull();
  });

  it("ignores a cancel or a restart, which say nothing about the model", () => {
    expect(
      misconfiguredStage(
        history({}, {}, { status: "cancelled" }, { status: "failed" }),
        "evaluate",
      ),
    ).toBeNull();
  });

  it("ignores loop runs that never ran an iteration or stopped for the planner", () => {
    // The shape of the real thing: one loop that ticked every task without
    // DONE, then two "Retry failed step" clicks that died in milliseconds on
    // the same exhausted checklist. Nothing here is about the model.
    expect(
      misconfiguredStage(
        history(
          { kind: "loop", iterationsDone: 6, exitReason: "plan checklist exhausted without a DONE signal" },
          { kind: "loop", iterationsDone: 0, exitReason: "plan checklist exhausted without a DONE signal" },
          { kind: "loop", iterationsDone: 0, exitReason: "plan checklist exhausted without a DONE signal" },
        ),
        "loop",
      ),
    ).toBeNull();
    // A blocker outside the loop's control says nothing about the model either.
    expect(
      misconfiguredStage(
        history(
          { kind: "loop", iterationsDone: 3, exitReason: "stalled" },
          { kind: "loop", iterationsDone: 2, exitReason: "stalled" },
          { kind: "loop", iterationsDone: 1, exitReason: "loop blocked" },
        ),
        "loop",
      ),
    ).toBeNull();
    // Three real failures still count, whatever sits between them.
    expect(
      misconfiguredStage(
        history(
          { kind: "loop", iterationsDone: 3, exitReason: "stalled" },
          { kind: "loop", iterationsDone: 0, exitReason: "plan checklist exhausted without a DONE signal" },
          { kind: "loop", iterationsDone: 2, exitReason: "stalled" },
          { kind: "loop", iterationsDone: 4, exitReason: "stuck" },
        ),
        "loop",
      ),
    ).toMatchObject({ kind: "loop", attempts: 3 });
  });

  it("judges each stage on its own history", () => {
    // A planner that failed three times is a planner problem even though an
    // evaluator run happened after it. finishRun only ever asks about the
    // stage that just ended, so a stale streak is never announced.
    const runs = history(
      { kind: "plan" },
      { kind: "plan" },
      { kind: "plan" },
      { kind: "evaluate" },
    );
    expect(misconfiguredStage(runs, "plan")).toMatchObject({ kind: "plan", attempts: 3 });
    expect(misconfiguredStage(runs, "evaluate")).toBeNull();
  });

  it("reads back as a sentence naming the role and the model", () => {
    expect(
      diagnosisMessage({ kind: "evaluate", provider: "omlx", model: "llm", attempts: 5 }),
    ).toBe(
      "The evaluator has failed 5 times in a row on omlx/llm. A different model for this role is the next thing to try.",
    );
  });

  it("names the plan critic when the critique stage is the one failing", () => {
    expect(
      diagnosisMessage({ kind: "critique", provider: "omlx", model: "llm", attempts: 3 }),
    ).toBe(
      "The plan critic has failed 3 times in a row on omlx/llm. A different model for this role is the next thing to try.",
    );
  });
});
