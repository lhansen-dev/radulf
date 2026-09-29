import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { RunSandboxContext } from "./sandbox/context";
import { guardPath, realpathBestEffort } from "./sandbox/pathGuard";
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
 * The first word is only the first guard. Each supported command has a strict
 * argument grammar below, and every path is confined to the worktree.
 */
const PROBE_ALLOWED = new Set(["find", "grep", "rg", "tail", "test"]);

/** Backticked spans in the criteria document. */
const BACKTICK_SPAN = /`([^`\n]+)`/g;

/**
 * Anything the shell would act on rather than pass through as an argument:
 * command separators and lists (`;`, `&`, `|`), substitution (`$`), a
 * subshell (`(`, `)`), and redirection (`<`, `>`).
 *
 * Backticks and newlines cannot appear in a span by construction. Glob
 * characters are allowed because safe path operands expand under the
 * worktree before the shell sees them.
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
 * The exit reason of the planning run a pre-check sends the plan back through.
 *
 * Lives next to the pre-check rather than at its one call site so the string
 * the pre-check reports and the string the replan is keyed on cannot drift
 * apart into two spellings of the same verdict.
 */
export const PRECHECK_REVISE_EXIT = "precheck revise";

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

type ParsedProbeCommand = {
  executable: string;
  args: string[];
  pathIndexes: number[];
  globPathIndexes: number[];
};

/** Split one command line without invoking a shell. */
function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
      started = true;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else word += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote || escaped) return null;
  if (started) words.push(word);
  return words;
}

const GREP_FLAGS = /^-[EFGHILPRhilnoqrsvwxz]+$/;
const RG_FLAGS = /^-[FHILNPUhilnqsvwxyz]+$/;

/** Accept only read-only forms whose path operands can be identified exactly. */
function parseProbeCommand(command: string): ParsedProbeCommand | null {
  if (SHELL_METACHARACTER.test(command)) return null;
  const words = shellWords(command);
  if (!words || words.length < 2 || !PROBE_ALLOWED.has(words[0])) return null;
  const [executable, ...args] = words;

  if (executable === "test") {
    const offset = args[0] === "!" ? 1 : 0;
    if (args.length !== offset + 2 || !/^-[efdLrsx]$/.test(args[offset])) return null;
    return { executable, args, pathIndexes: [offset + 1], globPathIndexes: [] };
  }

  if (executable === "tail") {
    if (args.length === 2 && args[0] === "-f") {
      return { executable, args, pathIndexes: [1], globPathIndexes: [] };
    }
    if (args.length === 3 && args[0] === "-n" && /^\d+$/.test(args[1])) {
      return { executable, args, pathIndexes: [2], globPathIndexes: [] };
    }
    return null;
  }

  if (executable === "grep" || executable === "rg") {
    const flagPattern = executable === "grep" ? GREP_FLAGS : RG_FLAGS;
    let index = 0;
    while (index < args.length && flagPattern.test(args[index])) index++;
    if (index > args.length - 2 || args[index].startsWith("-")) return null;
    const pathIndexes = args.slice(index + 1).map((_, i) => index + 1 + i);
    if (pathIndexes.some((i) => args[i].startsWith("-"))) return null;
    return { executable, args, pathIndexes, globPathIndexes: pathIndexes };
  }

  if (executable === "find") {
    let index = 0;
    const pathIndexes: number[] = [];
    while (index < args.length && !args[index].startsWith("-") && args[index] !== "!") {
      pathIndexes.push(index++);
    }
    if (pathIndexes.length === 0) return null;
    while (index < args.length) {
      const token = args[index++];
      if (
        [
          "-empty",
          "-readable",
          "-executable",
          "-print",
          "-print0",
          "!",
          "-not",
          "-a",
          "-and",
          "-o",
          "-or",
        ].includes(token)
      ) {
        continue;
      }
      const value = args[index++];
      if (value === undefined) return null;
      if (
        (token === "-type" && /^[fdl]$/.test(value)) ||
        ((token === "-maxdepth" || token === "-mindepth") && /^\d+$/.test(value)) ||
        token === "-name" ||
        token === "-iname"
      ) {
        continue;
      }
      return null;
    }
    return { executable, args, pathIndexes, globPathIndexes: [] };
  }

  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Expand a wildcard in one basename without handing it to a shell. */
function expandPathGlob(value: string, root: string): string[] | null {
  const directory = path.dirname(value);
  const basename = path.basename(value);
  if (/[*?]/.test(directory) || basename.includes("[")) return null;
  const canonicalDirectory = guardPath(directory, [root], root);
  const entries = fs.readdirSync(canonicalDirectory);
  if (entries.length > 2_000) return null;
  const expression = new RegExp(
    `^${basename.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`,
  );
  return entries
    .filter((entry) => expression.test(entry) && (basename.startsWith(".") || !entry.startsWith(".")))
    .map((entry) => guardPath(path.join(directory, entry), [root], root));
}

/** Canonicalize every path and expand globs before building a quoted command. */
function prepareProbeCommand(command: string, cwd: string): string | null {
  const parsed = parseProbeCommand(command);
  if (!parsed) return null;
  const root = realpathBestEffort(cwd);
  const args = [...parsed.args];
  for (const index of [...parsed.pathIndexes].sort((a, b) => b - a)) {
    const value = args[index];
    guardPath(value, [root], root);
    if (
      parsed.globPathIndexes.includes(index) &&
      (value.includes("*") || value.includes("?") || value.includes("["))
    ) {
      const safeMatches = expandPathGlob(value, root);
      if (!safeMatches) return null;
      args.splice(
        index,
        1,
        ...(safeMatches.length > 0 ? safeMatches : [guardPath(value, [root], root)]),
      );
    } else {
      args[index] = guardPath(value, [root], root);
    }
  }
  return [parsed.executable, ...args].map(shellQuote).join(" ");
}

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
    if (!parseProbeCommand(command) || found.has(command)) continue;
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
    let prepared: string;
    try {
      prepared = prepareProbeCommand(command, opts.worktreePath) ?? "";
    } catch {
      continue;
    }
    if (!prepared) continue;
    // The prefix is newline-separated lines ending in `|| true`, with no
    // trailing separator of its own. Concatenating the command straight onto
    // it makes it the right-hand side of that `||`, which never runs — the
    // probe then reads every check as passing. Join explicitly.
    const prefixed = ctx.commandPrefix ? `${ctx.commandPrefix}\n${prepared}` : prepared;
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

export type PrecheckReport = {
  /** New-behaviour commands the pre-check took a position on: each one that
   * ran, plus the single one a cancellation caught before it started. Not
   * `alreadyPassing.length + failing.length + unprobed.length`, which misses
   * that last one and counts none of the skipped regression checks. */
  checked: number;
  /** Commands that already exit the way their criterion wants — the finding
   * this whole pre-check exists for, since such a check cannot show that this
   * card's work got done. */
  alreadyPassing: string[];
  /** Commands that exit the wrong way. Expected: this is the untouched
   * worktree, so a check for new behaviour had better fail here. */
  failing: string[];
  /** Commands that never ran (missing binary, killed by the timeout, a wrap
   * that could not be built) — no position on those, either way. */
  unprobed: string[];
  /** The `## Regression` commands, deliberately not run. */
  skipped: string[];
  /** True when the caller's signal stopped the pre-check partway. A partial
   * report must never be read as a clean one. */
  cancelled: boolean;
};

/**
 * Run the plan's checks against the untouched worktree, before the loop starts.
 *
 * The post-DONE probe asks "did the work make these checks pass?". This asks
 * the opposite question, and the only one that can be answered before any
 * iteration exists: "do any of them pass already?" A check that exits the way
 * its criterion wants on a worktree nobody has touched will still exit that way
 * if the card does nothing at all, so it cannot evidence the work — and a plan
 * whose acceptance list is full of such checks will sail through DONE while
 * changing nothing. Finding them here costs one bounded replan instead of a
 * whole loop plus an evaluation.
 *
 * What it is NOT: a judgment of the plan's correctness. The probe is one-sided
 * (see this file's header) — a zero exit proves nothing about a criterion — and
 * a `failing` entry here is the expected, healthy outcome for new behaviour.
 * Only `alreadyPassing` gets acted on, and only as "this check cannot show the
 * work was done".
 *
 * `## Regression` commands are collected and not run: a check on behaviour an
 * earlier card established passing now is the point of it, so the pre-check
 * would flag every one of them as a tautology it isn't one. Sequential, and
 * wrapped in the run's sandbox policy exactly as `runAcceptanceProbe` wraps its
 * checks, for the same reasons stated there.
 */
export async function precheckAcceptance(opts: {
  acceptanceCriteria: string;
  worktreePath: string;
  ctx: RunSandboxContext;
  /** The planning run's cancellation. Checked before each command, never during
   * one: the running command is left to its own timeout rather than killed out
   * from under the sandbox's process-group bookkeeping. */
  signal?: AbortSignal;
  /** Exists only so tests can shorten the wait; production uses the probe's own
   * bound and must not acquire a second one. */
  timeoutMs?: number;
}): Promise<PrecheckReport> {
  const { ctx } = opts;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const { newBehavior, regression } = splitRegressionCriteria(opts.acceptanceCriteria);
  const report: PrecheckReport = {
    checked: 0,
    alreadyPassing: [],
    failing: [],
    unprobed: [],
    skipped: probeCommands(regression).map((c) => c.command),
    cancelled: false,
  };
  for (const { command, expectFailure } of probeCommands(newBehavior)) {
    // Considered before the cancellation check: `checked` is how many checks
    // the pre-check got around to, and the one cancellation caught is the last
    // thing it got around to. At most one command can be in that state, since
    // the loop stops right after it.
    report.checked++;
    if (opts.signal?.aborted) {
      report.cancelled = true;
      break;
    }
    // Join explicitly rather than concatenating: the prefix's last line ends in
    // `|| true`, and a command appended to it becomes that `||`'s right-hand
    // side and never runs — which here would read every check as already
    // passing and send the plan off for a revision it does not need.
    let prepared: string;
    try {
      prepared = prepareProbeCommand(command, opts.worktreePath) ?? "";
    } catch {
      report.unprobed.push(command);
      continue;
    }
    if (!prepared) {
      report.unprobed.push(command);
      continue;
    }
    const prefixed = ctx.commandPrefix ? `${ctx.commandPrefix}\n${prepared}` : prepared;
    try {
      const { ran, exitZero } = ctx.srtConfig
        ? await runSandboxedCommand(
            prefixed,
            ctx.srtConfig,
            (wrapped) => execCheck(wrapped, opts.worktreePath, ctx.env, timeoutMs),
            { tmpdir: ctx.tmpdir },
          )
        : await execCheck(prefixed, opts.worktreePath, ctx.env, timeoutMs);
      if (!ran) {
        // Never started: no position. Under this pre-check that matters more
        // than in the post-DONE probe — reading it as anything else either
        // invents a tautology or buries a real one.
        report.unprobed.push(command);
      } else if (exitZero !== expectFailure) {
        // Exited the way its criterion wants, ordinary or inverted — already.
        report.alreadyPassing.push(command);
      } else {
        report.failing.push(command);
      }
    } catch (e) {
      // A wrap that could not be built is our plumbing failing, not the
      // criterion's: unprobed, never already-passing, and the pre-check carries
      // on with the rest.
      console.warn(`acceptance pre-check skipped "${command}": ${errorMessage(e)}`);
      report.unprobed.push(command);
    }
  }
  return report;
}

/**
 * The feedback a pre-check sends back to the planner.
 *
 * Two exits for each flagged command, because half of them are legitimately
 * pass-now checks the planner simply filed in the wrong place: rewrite it into
 * a check that fails today, or mark it `## Regression` and it is exempt.
 * Explicitly disclaims the one thing the pre-check cannot say — that a zero
 * exit means a criterion is met — or the planner reads "these pass" as
 * permission to leave the whole list alone.
 */
export function precheckReviseFeedback(alreadyPassing: string[]): string {
  return [
    "These acceptance checks were run against the worktree as it stands, before",
    "any of this plan's tasks ran, and each already exits the way its criterion",
    "wants:",
    "",
    ...alreadyPassing.map((c) => `  - \`${c}\``),
    "",
    "So none of them can show that the work in this plan was done: they would",
    "report the same thing if the loop changed nothing at all. For each one,",
    "either rewrite it into a check that FAILS now and exits the way the",
    "criterion wants once the work is done, or — if it is meant to keep passing,",
    "because it guards behaviour an earlier card already established — move it",
    `under a \`${REGRESSION_HEADING}\` heading in CRITERIA.md. Regression checks`,
    "are exempt from this pre-check by design.",
    "",
    "This is not a judgment on the correctness of the plan. A zero exit proves",
    "nothing about a criterion, so nothing here says a criterion is satisfied",
    "or that the plan is sound; it says only that these commands cannot tell",
    "you anything about this card's work.",
  ].join("\n");
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
