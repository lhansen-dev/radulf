import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ralphDirPath } from "./bookkeeping";
import type { RunSandboxContext } from "./sandbox/context";
import { runSandboxedCommand } from "./sandbox/srt";
import { errorMessage } from "@/shared/errorMessage";

const execAsync = promisify(exec);

/**
 * Spec 27: the repository gate, run by the orchestrator so the evaluator
 * judges its result instead of spending its budget producing it.
 *
 * A repository may declare one command, `make check` for instance. It runs in
 * the worktree under the evaluator's sandbox context before the evaluator
 * harness is built, once per evaluation cycle, and its result goes to
 * `.ralph/GATE.md` and into the evaluator prompt as evidence. Never a verdict:
 * the evaluator stays the one judge.
 */

export const GATE_FILE = "GATE.md";
/** The end of the gate's combined output that reaches the file and the prompt. */
export const GATE_OUTPUT_CHARS = 8_000;
/** A chatty gate must not fill memory; only the tail is ever read. */
const GATE_MAX_BUFFER = 16 * 1024 * 1024;

export type GateResult = {
  command: string;
  /** The exit code; null when the command was killed or never ran. */
  exitCode: number | null;
  /** True when the gate's own timeout killed it. */
  timedOut: boolean;
  /** Why the command could not be run at all, or null when it ran. */
  error: string | null;
  durationMs: number;
  startedAt: string;
  /** The tail of stdout and stderr together. */
  output: string;
};

export function gateFilePath(worktreePath: string): string {
  return path.join(/* turbopackIgnore: true */ ralphDirPath(worktreePath), GATE_FILE);
}

function tail(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= GATE_OUTPUT_CHARS ? trimmed : `…${trimmed.slice(trimmed.length - GATE_OUTPUT_CHARS)}`;
}

type Outcome = Pick<GateResult, "exitCode" | "timedOut" | "error" | "output">;

async function execute(
  toRun: string,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  try {
    const { stdout, stderr } = await execAsync(toRun, { cwd, env, timeout, maxBuffer: GATE_MAX_BUFFER, signal });
    return { exitCode: 0, timedOut: false, error: null, output: tail(`${stdout}${stderr}`) };
  } catch (e) {
    // Cancelled from outside: the caller owns that outcome.
    if (signal?.aborted) throw e;
    const err = e as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
    const output = tail(`${err.stdout ?? ""}${err.stderr ?? ""}`);
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { exitCode: null, timedOut: false, error: "output exceeded the gate's buffer", output };
    }
    if (err.killed) return { exitCode: null, timedOut: true, error: null, output };
    if (typeof err.code === "number") return { exitCode: err.code, timedOut: false, error: null, output };
    return { exitCode: null, timedOut: false, error: errorMessage(e), output };
  }
}

/**
 * Run the gate in the worktree, wrapped in the run's sandbox policy when it
 * has one, exactly as the acceptance probe runs a criterion. Never throws for
 * an outcome of the command itself; only an external abort escapes.
 */
export async function runGateCommand(opts: {
  command: string;
  worktreePath: string;
  ctx: RunSandboxContext;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<GateResult> {
  const { command, worktreePath, ctx, timeoutMs, signal } = opts;
  const startedAt = new Date();
  // The prefix's lines end in `|| true` with no separator of their own; the
  // command must be its own line, not the right-hand side of that `||`.
  const prefixed = ctx.commandPrefix ? `${ctx.commandPrefix}\n${command}` : command;
  const run = (toRun: string) => execute(toRun, worktreePath, ctx.env, timeoutMs, signal);
  let outcome: Outcome;
  try {
    outcome = ctx.srtConfig ? await runSandboxedCommand(prefixed, ctx.srtConfig, run) : await run(prefixed);
  } catch (e) {
    if (signal?.aborted) throw e;
    // A wrap that could not be built: the gate did not run, and says so.
    outcome = { exitCode: null, timedOut: false, error: errorMessage(e), output: "" };
  }
  return {
    command,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    ...outcome,
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** The `.ralph/GATE.md` text: what ran, how it ended, and the end of its output. */
export function renderGateFile(result: GateResult): string {
  const ending = result.timedOut
    ? `killed by the gate timeout after ${formatDuration(result.durationMs)}`
    : result.error
      ? `did not run: ${result.error}`
      : `exit ${result.exitCode}`;
  return [
    "# Repository gate",
    "",
    `Command: \`${result.command}\``,
    `Result: ${ending}`,
    `Duration: ${formatDuration(result.durationMs)}`,
    `Ran at: ${result.startedAt}`,
    "",
    `## Output, last ${GATE_OUTPUT_CHARS} characters`,
    "",
    "```",
    result.output || "(no output)",
    "```",
    "",
  ].join("\n");
}

/** The end of the gate's output quoted in the loop's repair task (spec 29). */
export const GATE_REPAIR_OUTPUT_CHARS = 3_000;

/**
 * Spec 29: the task handed back to the loop when the gate fails after DONE.
 * It quotes only the end of the output; the whole of it is in `.ralph/GATE.md`.
 */
export function gateRepairTaskText(result: GateResult): string {
  const output = result.output.slice(-GATE_REPAIR_OUTPUT_CHARS) || "(no output)";
  return [
    `Repair the repository gate: the orchestrator ran \`${result.command}\` in the worktree after you signalled DONE and it exited ${result.exitCode}.`,
    "",
    "The end of its output:",
    ...output.split("\n").map((line) => `  ${line}`),
    "",
    "Fix the underlying problem rather than the command. Run only the part of the gate that failed as this task's targeted check, not the whole gate command.",
  ].join("\n");
}

/** The prompt section built from `.ralph/GATE.md`; empty when there is no file. */
export function renderGateSection(gateMd: string): string {
  if (!gateMd.trim()) return "";
  return (
    "\nREPOSITORY GATE\n===============\n" +
    "The orchestrator ran this repository's gate command in the worktree before this attempt " +
    "started. Its result is below and in `.ralph/GATE.md`. Do not run it again. Judge it: a " +
    "non-zero exit is evidence for your verdict, not an automatic revise, and a gate killed for " +
    "time is a fact about the gate, not about the change.\n\n" +
    `${gateMd.trim()}\n`
  );
}
