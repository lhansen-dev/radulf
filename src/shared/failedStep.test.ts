import { describe, expect, it } from "vitest";
import { retryableFailedStep, type PipelineStep } from "./failedStep";

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
