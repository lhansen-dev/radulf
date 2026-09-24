import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunSandboxContext } from "./sandbox/context";
import {
  GATE_OUTPUT_CHARS,
  GATE_REPAIR_OUTPUT_CHARS,
  gateRepairTaskText,
  renderGateFile,
  renderGateSection,
  runGateCommand,
  type GateResult,
} from "./gate";

/** No sandbox policy and no prefix: the plain path every unit test here takes. */
const ctx = { env: process.env, commandPrefix: undefined, srtConfig: undefined } as unknown as RunSandboxContext;
const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-gate-"));

describe("runGateCommand", () => {
  it("reports a passing command with its output", async () => {
    const result = await runGateCommand({ command: "printf 'all green'", worktreePath, ctx, timeoutMs: 5_000 });
    expect(result).toMatchObject({ command: "printf 'all green'", exitCode: 0, timedOut: false, error: null, output: "all green" });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(result.startedAt)).not.toBeNaN();
  });

  it("reports a failing command's exit code and its combined output", async () => {
    const result = await runGateCommand({ command: "echo out; echo err 1>&2; exit 3", worktreePath, ctx, timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, error: null });
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  it("kills a command that outlives the gate timeout and says so", async () => {
    const result = await runGateCommand({ command: "sleep 5", worktreePath, ctx, timeoutMs: 200 });
    expect(result).toMatchObject({ exitCode: null, timedOut: true, error: null });
  });

  it("keeps only the tail of a long output", async () => {
    const result = await runGateCommand({
      command: `head -c ${GATE_OUTPUT_CHARS * 3} /dev/zero | tr '\\0' 'x'; printf END`,
      worktreePath,
      ctx,
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeLessThanOrEqual(GATE_OUTPUT_CHARS + 1);
    expect(result.output.endsWith("END")).toBe(true);
    expect(result.output.startsWith("…")).toBe(true);
  });

  it("runs the sandbox command prefix on its own line, never as the left of the command's ||", async () => {
    const prefixed = { ...ctx, commandPrefix: "false || true" } as unknown as RunSandboxContext;
    const result = await runGateCommand({ command: "printf ran; exit 4", worktreePath, ctx: prefixed, timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 4, output: "ran" });
  });

  it("lets an external abort escape to the caller instead of reporting an outcome", async () => {
    const controller = new AbortController();
    const pending = runGateCommand({ command: "sleep 5", worktreePath, ctx, timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("renderGateFile and renderGateSection", () => {
  const base = {
    command: "make check",
    startedAt: "2026-09-23T21:00:00.000Z",
    durationMs: 125_000,
    output: "ok",
    error: null,
    timedOut: false,
    exitCode: 0,
  };

  it("names the command, the result, the duration, and the output", () => {
    const md = renderGateFile(base);
    expect(md).toContain("Command: `make check`");
    expect(md).toContain("Result: exit 0");
    expect(md).toContain("Duration: 2m 5s");
    expect(md).toContain("Ran at: 2026-09-23T21:00:00.000Z");
    expect(md).toContain("```\nok\n```");
    expect(renderGateFile({ ...base, exitCode: null, timedOut: true })).toContain("Result: killed by the gate timeout after 2m 5s");
    expect(renderGateFile({ ...base, exitCode: null, error: "wrap failed", output: "" })).toContain("Result: did not run: wrap failed");
    expect(renderGateFile({ ...base, output: "" })).toContain("(no output)");
  });

  it("wraps the file in a section that forbids re-running, and renders nothing for no file", () => {
    expect(renderGateSection("")).toBe("");
    const section = renderGateSection(renderGateFile(base));
    expect(section).toContain("REPOSITORY GATE");
    expect(section).toContain("Do not run it again");
    expect(section).toContain("Command: `make check`");
  });
});

describe("gateRepairTaskText (spec 29)", () => {
  it("names the command and exit code, and quotes only the last 3000 characters of output", () => {
    const tail = "y".repeat(GATE_REPAIR_OUTPUT_CHARS);
    const result: GateResult = {
      command: "make check",
      startedAt: "2026-09-23T21:00:00.000Z",
      durationMs: 1_000,
      output: `${"x".repeat(500)}${tail}`,
      error: null,
      timedOut: false,
      exitCode: 2,
    };
    const text = gateRepairTaskText(result);
    expect(text.split("\n")[0]).toBe(
      "Repair the repository gate: the orchestrator ran `make check` in the worktree after you signalled DONE and it exited 2.",
    );
    expect(text).toContain("The end of its output:\n  " + tail + "\n");
    expect(text).not.toContain("xy");
    expect(text).toContain("Run only the part of the gate that failed");
    expect(gateRepairTaskText({ ...result, output: "" })).toContain("  (no output)");
  });
});
