import { describe, expect, it } from "vitest";
import { integrityViolationReason } from "./stage";
import type { RunSandboxContext } from "./sandbox/context";

// integrityViolationReason only calls ctx.reap(), so the stub needs nothing else.
function ctxWithReap(leftover: number[]): RunSandboxContext {
  return { reap: async () => leftover } as unknown as RunSandboxContext;
}

describe("integrityViolationReason (spec 14: reap must be verified, not just performed)", () => {
  it("reports surviving process groups instead of discarding them", async () => {
    const reason = await integrityViolationReason(ctxWithReap([4242]), "/repo", null, "ralph/x-1");
    expect(reason).toContain("4242");
  });

  it("says nothing when the group came up empty (control)", async () => {
    const reason = await integrityViolationReason(ctxWithReap([]), "/repo", null, "ralph/x-1");
    expect(reason).toBeNull();
  });
});
