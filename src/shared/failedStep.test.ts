import { describe, expect, it } from "vitest";
import { CHECKLIST_EXHAUSTED_EXIT, LOOP_BLOCKED_EXIT, retryableFailedStep, type PipelineStep } from "./failedStep";

describe("retryableFailedStep", () => {
  it.each<PipelineStep>(["plan", "loop", "evaluate"])(
    "recognizes a failed %s run",
    (kind) => {
      expect(
        retryableFailedStep([
          {
            kind,
            status: "failed",
            startedAt: "2026-07-17T10:00:00.000Z",
            endedAt: "2026-07-17T10:01:00.000Z",
          },
        ]),
      ).toBe(kind);
    },
  );

  it("offers no retry for a request the provider rejected outright", () => {
    // Spec 18 §3: the retry button produced three identical one-turn,
    // zero-token planner failures against a model the client could not drive.
    expect(
      retryableFailedStep([
        {
          kind: "plan",
          status: "failed",
          failureKind: "config",
          startedAt: "2026-07-17T10:00:00.000Z",
          endedAt: "2026-07-17T10:00:01.000Z",
        },
      ]),
    ).toBeNull();
  });

  it.each([LOOP_BLOCKED_EXIT, CHECKLIST_EXHAUSTED_EXIT])(
    "offers no retry for a loop that ended '%s' — the planner's move, not the loop's",
    (exitReason) => {
      // Re-running an exhausted checklist has nothing to inject and fails in
      // milliseconds; a blocker outside the loop's control is still there.
      expect(
        retryableFailedStep([
          {
            kind: "loop",
            status: "failed",
            exitReason,
            startedAt: "2026-09-21T16:14:00.000Z",
            endedAt: "2026-09-21T16:14:33.000Z",
          },
        ]),
      ).toBeNull();
    },
  );

  it("still offers a retry for a loop that failed for any other reason", () => {
    expect(
      retryableFailedStep([
        { kind: "loop", status: "failed", exitReason: "stalled", startedAt: "2026-09-21T16:14:00.000Z" },
      ]),
    ).toBe("loop");
  });

  it.each(["conn", "limit", null])(
    "still offers a retry for a %s failure, which can clear on its own",
    (failureKind) => {
      expect(
        retryableFailedStep([
          {
            kind: "loop",
            status: "failed",
            failureKind,
            startedAt: "2026-07-17T10:00:00.000Z",
            endedAt: "2026-07-17T10:01:00.000Z",
          },
        ]),
      ).toBe("loop");
    },
  );

  it.each(["failed", "timeout", "interrupted"])(
    "treats %s as retryable",
    (status) => {
      expect(
        retryableFailedStep([
          {
            kind: "loop",
            status,
            startedAt: "2026-07-17T10:00:00.000Z",
          },
        ]),
      ).toBe("loop");
    },
  );

  it("does not revive an older failure after a later successful run", () => {
    expect(
      retryableFailedStep([
        {
          kind: "loop",
          status: "failed",
          startedAt: "2026-07-17T10:00:00.000Z",
          endedAt: "2026-07-17T10:01:00.000Z",
        },
        {
          kind: "evaluate",
          status: "completed",
          startedAt: "2026-07-17T10:02:00.000Z",
          endedAt: "2026-07-17T10:03:00.000Z",
        },
      ]),
    ).toBeNull();
  });

  it("hides retry while a newer attempt is running", () => {
    expect(
      retryableFailedStep([
        {
          kind: "evaluate",
          status: "failed",
          startedAt: "2026-07-17T10:00:00.000Z",
          endedAt: "2026-07-17T10:01:00.000Z",
        },
        {
          kind: "evaluate",
          status: "running",
          startedAt: "2026-07-17T10:02:00.000Z",
        },
      ]),
    ).toBeNull();
  });
});
