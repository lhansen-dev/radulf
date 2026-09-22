#!/usr/bin/env node

/**
 * run-benchmark.mjs — dependency-free Node ESM benchmark runner for
 * Radulf Phase 3 loop-performance benchmarking.
 *
 * Runs one candidate loop provider/model and a configurable planner model
 * against a fixture under benchmarks/
 * (snake-tui, small-ui-change, server-data-change, failing-test-repair)
 * at least three times and collects every Phase 3 metric.
 *
 * Fixtures with a seed/ directory are existing-codebase fixtures: the seed
 * is committed into the target repo before the first run. Between runs the
 * repo is hard-reset to the pre-benchmark baseline commit so every run
 * starts identical — point --repo at a throwaway benchmark repo.
 *
 * Requires Node >= 18 (global `fetch`).
 *
 * Pure helpers (selectReviewRun, aggregateTokens, percentile, median,
 * parseCriteriaCommand) are exported for unit testing and have no side
 * effects on import. Everything else — argument parsing, validation, and
 * main() — only runs when this file is executed directly, so `import`ing it
 * from a test never touches argv or the network.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";

const fsReadFile = readFile;
const fsWriteFile = writeFile;
const fsAccess = access;

// ── Pure helpers (exported for tests) ──────────────────────────

/** Nearest-rank percentile (0-100) over an ascending-sorted array: the same
 * rule as `percentile` in src/server/analytics.ts, so a report's p50/p90
 * match the analytics tab for the same durations. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Median = p50 */
export function median(sorted) {
  return percentile(sorted, 50);
}

/** Parse a CRITERIA.md line like: \`- \`command\` exits 0\` */
export function parseCriteriaCommand(line) {
  const m = line.match(/^-\s*`([^`]+)`\s+(?:exits 0|succeeds)/);
  return m ? m[1] : null;
}

/**
 * A card is a plan run plus one or more loop → evaluate cycles, so the run to
 * review is not `card.latestRun` (whichever run finished last — after a
 * normal pipeline, that's the *evaluate* run: zero iterations, zero tokens,
 * and rejected by POST /api/reviews, which requires a completed loop run).
 * `cardRuns` must be newest-first, so the first match is the current loop.
 */
export function selectReviewRun(cardRuns) {
  return cardRuns.find((r) => r.kind === "loop" && r.status === "completed") ?? null;
}

/**
 * Token and cost totals must span every run on the card — plan, every loop,
 * every evaluate — not just the reviewed run, or a card with revisions
 * (evaluator `revise`s adding another loop → evaluate pair) undercounts what
 * it actually cost. `runDetails` is the array of `{ run, iterations }` from
 * GET /api/runs/:id for each run on the card.
 *
 * Each run's own telemetry roll-up (`run.promptTokens`, `run.costUsd`, etc —
 * populated for every kind since the runs-table telemetry migration) is
 * preferred over summing that run's iterations. Iterations only ever existed
 * for loop, so before this migration a plan or evaluate run always summed to
 * zero; falling back to the iteration sum only covers runs from a server
 * that predates the migration.
 */
export function aggregateTokens(runDetails) {
  const allIterations = runDetails.flatMap((d) => d.iterations || []);
  const loopIterations = runDetails
    .filter((d) => d.run.kind === "loop")
    .flatMap((d) => d.iterations || []);

  const perRun = runDetails.map((d) => {
    const iters = d.iterations || [];
    const sumIters = (key) => iters.reduce((s, it) => s + (it[key] || 0), 0);
    const field = (key) => d.run[key] ?? sumIters(key);
    return {
      kind: d.run.kind,
      promptTokens: field("promptTokens"),
      completionTokens: field("completionTokens"),
      cachedInputTokens: field("cachedInputTokens"),
      reasoningTokens: field("reasoningTokens"),
      modelTurns: field("modelTurns"),
      costUsd: field("costUsd"),
    };
  });

  const sum = (key) => perRun.reduce((s, r) => s + (r[key] || 0), 0);

  // Per-role cost breakdown — the whole point of measuring is knowing which
  // role to economize on.
  const costByKind = {};
  for (const r of perRun) {
    costByKind[r.kind] = (costByKind[r.kind] || 0) + (r.costUsd || 0);
  }

  return {
    allIterations,
    loopIterations,
    totalModelTurns: sum("modelTurns"),
    sumPromptTokens: sum("promptTokens"),
    sumCachedInputTokens: sum("cachedInputTokens"),
    sumCompletionTokens: sum("completionTokens"),
    sumReasoningTokens: sum("reasoningTokens"),
    sumCostUsd: sum("costUsd"),
    costByKind,
  };
}

export function sortAsc(arr) {
  return [...arr].sort((a, b) => a - b);
}

export function computeStats(arr) {
  if (arr.length === 0) return null;
  const sorted = sortAsc(arr);
  return {
    count: arr.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: median(sorted),
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    mean: arr.reduce((s, v) => s + v, 0) / arr.length,
  };
}

/** Format milliseconds as a human-readable string. */
export function msToHuman(ms) {
  if (ms == null) return "N/A";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = (ms % 60_000) / 1000;
  return `${m}m ${s.toFixed(0)}s`;
}

// ── Non-CLI internal helpers ────────────────────────────────────

async function assertOk(res, context) {
  if (!res.ok) {
    throw new Error(await responseError(res, context));
  }
  return res;
}

async function responseError(res, context) {
  const detail = (await res.text().catch(() => "")).trim();
  return `${context}: HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse ISO timestamp string to epoch ms. */
function parseTs(ts) {
  return new Date(ts).getTime();
}

/**
 * Execute a command with a timeout, returning { exitCode, stdout, stderr }.
 * Uses child_process.execFile for safety.
 */
function execCmd(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, {
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeout || 30_000,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    }, (error, stdout, stderr) => {
      if (error && error.killed) {
        // Timeout
        resolve({ exitCode: null, stdout: stdout || "", stderr: stderr || "", error: "Timed out" });
      } else if (error) {
        resolve({ exitCode: error.code || 1, stdout: stdout || "", stderr: stderr || "" });
      } else {
        resolve({ exitCode: 0, stdout: stdout || "", stderr: stderr || "" });
      }
    });
  });
}

// ── CLI entry point ──────────────────────────────────────────────
// Everything below only executes when this file is run directly (`node
// benchmarks/run-benchmark.mjs ...`), not when imported — so tests can pull
// in the helpers above without touching argv, the filesystem beyond the
// fixture corpus, or the network.

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  await runCli();
}

async function runCli() {
  const USAGE = `Usage: node benchmarks/run-benchmark.mjs [options]

Options:
  --fixture <name>          Fixture directory under benchmarks/ (required)
  --base-url <url>          Radulf server base URL (default: http://localhost:3000)
  --repo <id>               Registered throwaway-repo ID (required)
  --provider <name>         Provider name for the loop (required)
  --model <name>            Model name for the loop (required)
  --planner-model <name>    Planner model (default: loop model)
  --runs <n>                Number of benchmark runs (default: 3)
  --auth-cookie <value>     Session cookie value for authentication
  --password <value>        Password to POST /api/auth/login and read Set-Cookie
  --max-iterations <n>      Optional card maxIterations override
  --timeout-minutes <n>     Optional card timeoutMinutes override
  --auto-review             Approve (criteria pass) or abandon (criteria fail) each run
  --no-reset                Skip the per-run hard reset to the baseline commit
  --out <path>              JSON report output path (default: stdout)
  --dry-run                 Validate args, print plan, exit 0 (no API calls)
  --help                    Show this help message and exit
`;

  // ── Argument parsing ───────────────────────────────────────────

  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (a.startsWith("--")) {
      const key = a.replace(/^--/, "").replace(/-/g, "_");
      const next = process.argv[i + 1];
      if (key === "dry_run" || key === "auto_review" || key === "no_reset" || key === "help") {
        args[key] = true;
      } else if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }

  const {
    fixture,
    base_url = "http://localhost:3000",
    repo,
    provider,
    model,
    planner_model = model,
    runs = "3",
    auth_cookie,
    password,
    max_iterations,
    timeout_minutes,
    auto_review,
    no_reset,
    out,
    dry_run,
  } = args;

  const numRuns = parseInt(runs, 10);
  if (isNaN(numRuns) || numRuns < 1) {
    console.error("Error: --runs must be a positive integer");
    process.exit(1);
  }

  // ── Validation ─────────────────────────────────────────────────

  // Resolve fixture paths relative to this script's directory
  const scriptDir = new URL(".", import.meta.url).pathname;
  const fixtureDir = fixture ? `${scriptDir}${fixture}/` : null;
  const seedDir = fixtureDir ? `${fixtureDir}seed` : null;
  const hasSeed = seedDir ? existsSync(seedDir) : false;

  const errors = [];
  if (!fixture) errors.push("--fixture is required");
  else if (!existsSync(`${fixtureDir}TASK.md`) || !existsSync(`${fixtureDir}CRITERIA.md`)) {
    errors.push(`--fixture ${fixture}: no TASK.md + CRITERIA.md under ${fixtureDir}`);
  }
  if (!repo) errors.push("--repo is required");
  if (!provider) errors.push("--provider is required");
  if (!model) errors.push("--model is required");
  if (!auth_cookie && !password) errors.push("either --auth-cookie or --password is required");
  if (errors.length > 0) {
    for (const e of errors) console.error(`Error: ${e}`);
    console.error("");
    console.error(USAGE);
    process.exit(1);
  }

  // ── Dry run ────────────────────────────────────────────────────

  if (dry_run) {
    const plan = [
      `Benchmark plan (dry run, no API calls):`,
      `  Fixture:         ${fixture}${hasSeed ? " (seeded existing-codebase fixture)" : " (greenfield)"}`,
      `  Base URL:        ${base_url}`,
      `  Repo ID:         ${repo}`,
      `  Loop provider:   ${provider}`,
      `  Loop model:      ${model}`,
      `  Planner model:   ${planner_model}`,
      `  Runs:            ${numRuns}`,
      `  Auth:            ${auth_cookie ? "cookie provided" : "password login"}`,
      `  Max iterations:  ${max_iterations || "(default)"}`,
      `  Timeout minutes: ${timeout_minutes || "(default)"}`,
      `  Auto-review:     ${auto_review ? "yes" : "no"}`,
      `  Per-run reset:   ${no_reset ? "no" : "yes (hard reset to baseline commit)"}`,
      `  Output:          ${out || "(stdout)"}`,
      ``,
      `Steps:`,
      `  1. Resolve repo path via GET /api/repos${hasSeed ? "; commit seed/ into the repo" : ""},`,
      `     record baseline commit SHA`,
      `  2. For each run:`,
      `     a. Hard-reset repo to baseline (unless --no-reset)`,
      `     b. Read TASK.md for title + description`,
      `     c. POST /api/cards with repo, title, description, plannerModel, loopModel`,
      `     d. POST /api/cards/[id]/move {to: "todo"}`,
      `     e. POST /api/cards/[id]/move {to: "in_progress"}`,
      `     f. Poll GET /api/cards until terminal status`,
      `     g. GET /api/cards/[id] for every run; sum tokens/cost across all`,
      `     h. Compute per-run metrics`,
      `     i. Execute CRITERIA.md commands in worktree`,
      `     j. Compute diff correctness`,
      `  3. Aggregate metrics across runs`,
      `  4. Write JSON report to ${out || "stdout"}`,
      ``,
      `Note: Loops are serialized by the orchestrator's single pipeline slot,`,
      `      so concurrency cannot mask per-loop latency. No setup needed.`,
      `Note: The per-run reset discards commits the benchmark itself created`,
      `      (including approved merges) — use a throwaway repo.`,
    ];
    for (const line of plan) console.log(line);
    process.exit(0);
  }

  // ── Main ───────────────────────────────────────────────────────

  async function main() {
    const taskMdPath = fixtureDir + "TASK.md";
    const criteriaMdPath = fixtureDir + "CRITERIA.md";

    // Read TASK.md
    let taskMd;
    try {
      taskMd = await fsReadFile(taskMdPath, "utf8");
    } catch {
      throw new Error(`Cannot read TASK.md at ${taskMdPath}`);
    }
    const taskLines = taskMd.trimStart().split("\n");
    const title = taskLines[0].trim();
    const description = taskLines.slice(1).join("\n").trim();

    // Read CRITERIA.md
    let criteriaMd;
    try {
      criteriaMd = await fsReadFile(criteriaMdPath, "utf8");
    } catch {
      throw new Error(`Cannot read CRITERIA.md at ${criteriaMdPath}`);
    }

    // Parse criteria commands
    const criteriaCommands = criteriaMd
      .split("\n")
      .map(parseCriteriaCommand)
      .filter(Boolean);

    // ── Auth ─────────────────────────────────────────────────────

    let cookie = auth_cookie;
    if (!cookie && password) {
      const loginRes = await fetch(`${base_url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        redirect: "manual",
      });
      // The login endpoint returns a 302 redirect with a Set-Cookie header
      const setCookie = loginRes.headers.get("set-cookie");
      if (!setCookie) {
        throw new Error("Login failed: no Set-Cookie header in response");
      }
      // Extract the cookie value (everything before the first ';')
      cookie = setCookie.split(";")[0].trim();
    }

    const authHeaders = {
      Cookie: cookie,
      "Content-Type": "application/json",
    };

    // ── Resolve repo path, commit seed, record baseline ──────────

    const reposRes = await fetch(`${base_url}/api/repos`, { headers: authHeaders });
    await assertOk(reposRes, "GET /api/repos");
    const repoRow = (await reposRes.json()).find((r) => r.id === repo);
    if (!repoRow) throw new Error(`Repo ${repo} is not registered`);
    const repoPath = repoRow.path;
    const defaultBranch = repoRow.defaultBranch || "main";

    async function git(...gitArgs) {
      const { exitCode, stdout, stderr } = await execCmd("git", ["-C", repoPath, ...gitArgs], {
        timeout: 60_000,
      });
      if (exitCode !== 0) {
        throw new Error(`git ${gitArgs.join(" ")} exited ${exitCode}: ${stderr || stdout}`);
      }
      return stdout.trim();
    }

    await git("checkout", "-q", defaultBranch);

    if (hasSeed) {
      console.log(`Seeding ${repoPath} from ${seedDir}/`);
      await git("rm", "-rfq", "--ignore-unmatch", ".");
      await git("clean", "-fdq");
      const { exitCode: cpCode, stderr: cpErr } = await execCmd(
        "cp", ["-R", `${seedDir}/.`, repoPath], { timeout: 30_000 },
      );
      if (cpCode !== 0) throw new Error(`Seed copy failed: ${cpErr}`);
      await git("add", "-A");
      const dirty = await git("status", "--porcelain");
      if (dirty) {
        await git(
          "-c", "user.name=radulf-benchmark",
          "-c", "user.email=benchmark@radulf.local",
          "commit", "-qm", `benchmark: seed ${fixture}`,
        );
      }
    }

    const baselineSha = await git("rev-parse", "HEAD");
    console.log(`Baseline commit: ${baselineSha}`);

    // Serialization needs no setup any more. The orchestrator has a single
    // pipeline slot — `pipelineBusy()` blocks `pump()` while any card is
    // planning, looping, or evaluating — so one card runs at a time by
    // construction. This used to PATCH a `maxParallelLoops` setting; that
    // setting no longer exists, and `patchSettings` silently skips unknown
    // keys, so the call had been a no-op reporting success.

    // ── Per-run data ─────────────────────────────────────────────

    const runResults = [];

    for (let runIdx = 1; runIdx <= numRuns; runIdx++) {
      console.log(`\n--- Run ${runIdx}/${numRuns} ---`);

      // Every run starts from the identical baseline; without this, an
      // approved run's merge (or dirt left by a previous crashed invocation)
      // would leak into the run's starting state.
      if (!no_reset) {
        await git("checkout", "-q", defaultBranch);
        await git("reset", "-q", "--hard", baselineSha);
        await git("clean", "-fdq");
        console.log(`  Reset repo to baseline ${baselineSha.slice(0, 8)}`);
      }

      // ── Step 2a: create card ─────────────────────────────────

      const cardBody = {
        repoId: repo,
        title,
        description,
        plannerModel: planner_model,
        loopModel: model,
      };
      if (max_iterations) cardBody.maxIterations = parseInt(max_iterations, 10);
      if (timeout_minutes) cardBody.timeoutMinutes = parseInt(timeout_minutes, 10);

      const createRes = await fetch(`${base_url}/api/cards`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(cardBody),
      });
      await assertOk(createRes, "POST /api/cards");
      const card = await createRes.json();
      const cardId = card.id;
      console.log(`  Created card ${cardId}: "${title}"`);

      // ── Step 2b: start the card ──────────────────────────────

      // Queue from backlog to todo first (best-effort; auto-mode may have done it)
      try {
        const queueRes = await fetch(`${base_url}/api/cards/${cardId}/move`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ to: "todo" }),
        });
        if (!queueRes.ok) {
          console.warn(`  Warning: could not queue card ${cardId} to todo (auto-mode may have already moved it)`);
        } else {
          console.log(`  Queued card ${cardId} to todo`);
        }
      } catch (e) {
        console.warn(`  Warning: error queuing card ${cardId} to todo: ${e.message}`);
      }

      const moveRes = await fetch(`${base_url}/api/cards/${cardId}/move`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ to: "in_progress" }),
      });
      if (moveRes.ok) {
        console.log(`  Moved card ${cardId} to in_progress`);
      } else {
        const moveError = await responseError(moveRes, `POST /api/cards/${cardId}/move`);
        // Auto mode can start a freshly-created card between the create and
        // move requests. Treat that race as success if the card is already
        // running; otherwise remove the unusable benchmark card before
        // surfacing the original error.
        const cardsRes = await fetch(`${base_url}/api/cards`, { headers: authHeaders });
        await assertOk(cardsRes, "GET /api/cards after failed move");
        const currentCard = (await cardsRes.json()).find((c) => c.id === cardId);
        if (["planning", "ready", "looping"].includes(currentCard?.status)) {
          console.log(`  Card ${cardId} was already started (${currentCard.status})`);
        } else {
          // Only a Todo card is an inert partial launch. Preserve terminal
          // cards because they may contain a useful failed plan/run.
          if (currentCard?.status !== "todo") throw new Error(moveError);
          const cleanupRes = await fetch(`${base_url}/api/cards/${cardId}`, {
            method: "DELETE",
            headers: authHeaders,
          });
          if (!cleanupRes.ok) {
            console.warn(`  Warning: could not clean up card ${cardId} after failed start`);
          }
          throw new Error(moveError);
        }
      }

      // ── Step 2c: poll until terminal ─────────────────────────

      let terminalStatus;
      let latestRunId = null;
      const pollIntervalMs = 5000; // 5 seconds

      for (;;) {
        await sleep(pollIntervalMs);
        const pollRes = await fetch(`${base_url}/api/cards`, { headers: authHeaders });
        await assertOk(pollRes, "GET /api/cards poll");
        const allCards = await pollRes.json();
        const currentCard = allCards.find((c) => c.id === cardId);
        if (!currentCard) {
          throw new Error(`Card ${cardId} not found during polling`);
        }
        const status = currentCard.status;
        if (status === "review" || status === "needs_attention" || status === "done" || status === "abandoned") {
          terminalStatus = status;
          latestRunId = currentCard.latestRun?.id ?? null;
          console.log(`  Card reached terminal status: ${status}`);
          break;
        }
        // Also check for "done" status — not expected in benchmark but handle gracefully
        console.log(`  Polling... card status: ${status}`);
      }

      // ── Step 2d: fetch run data ──────────────────────────────

      if (!latestRunId) {
        console.warn(`  Warning: no run ID found for card ${cardId}, skipping metrics`);
        runResults.push({
          run: runIdx,
          cardId,
          status: terminalStatus,
          error: "No run ID found",
        });
        continue;
      }

      const cardRes = await fetch(`${base_url}/api/cards/${cardId}`, { headers: authHeaders });
      await assertOk(cardRes, `GET /api/cards/${cardId}`);
      const cardDetail = await cardRes.json();
      const cardRuns = cardDetail.runs || [];

      const reviewRun = selectReviewRun(cardRuns);
      const reviewRunId = reviewRun?.id ?? null;

      // Pull iterations for every run, so totals cover the whole card.
      const runDetails = [];
      for (const r of cardRuns) {
        const rRes = await fetch(`${base_url}/api/runs/${r.id}`, { headers: authHeaders });
        await assertOk(rRes, `GET /api/runs/${r.id}`);
        runDetails.push(await rRes.json());
      }

      const {
        loopIterations,
        totalModelTurns,
        sumPromptTokens,
        sumCachedInputTokens,
        sumCompletionTokens,
        sumReasoningTokens,
        sumCostUsd,
        costByKind,
      } = aggregateTokens(runDetails);

      const run = runDetails.find((d) => d.run.id === reviewRunId)?.run ?? runDetails[0]?.run;

      console.log(
        `  Card ran ${cardRuns.length} runs ` +
          `(${cardRuns.filter((r) => r.kind === "loop").length} loop, ` +
          `${cardRuns.filter((r) => r.kind === "evaluate").length} evaluate), ` +
          `${loopIterations.length} loop iterations`,
      );

      // ── Step 2e: compute per-card metrics ────────────────────

      // Whole-card wall time: first run started → last run ended.
      const runStarts = runDetails.map((d) => d.run.startedAt).filter(Boolean).map(parseTs);
      const runEnds = runDetails.map((d) => d.run.endedAt).filter(Boolean).map(parseTs);
      const totalWallTimeMs = runStarts.length && runEnds.length
        ? Math.max(...runEnds) - Math.min(...runStarts)
        : null;

      const iterationCount = loopIterations.length;

      // Latency percentiles describe the loop, so they use loop iterations only.
      const iterationWallTimes = loopIterations
        .filter((it) => it.endedAt && it.startedAt)
        .map((it) => parseTs(it.endedAt) - parseTs(it.startedAt))
        .sort((a, b) => a - b);

      const p50IterationTime = iterationWallTimes.length > 0
        ? percentile(iterationWallTimes, 50)
        : null;
      const p90IterationTime = iterationWallTimes.length > 0
        ? percentile(iterationWallTimes, 90)
        : null;

      let reviewOutcome = terminalStatus === "review" ? "pending" : terminalStatus;

      // ── Step 2f: execute CRITERIA.md commands ────────────────

      const worktreePath = run.worktreePath;
      let criteriaPass = false;
      const criteriaResults = [];

      if (worktreePath) {
        // Install requirements if present
        const reqFile = `${worktreePath}/requirements.txt`;
        try {
          await fsAccess(reqFile);
          console.log(`  Installing requirements from ${reqFile}...`);
          try {
            const { exitCode: pipCode } = await execCmd(
              "python3", ["-m", "pip", "install", "-q", "-r", "requirements.txt"],
              { cwd: worktreePath, timeout: 120_000 }
            );
            if (pipCode !== 0) {
              console.warn("  Warning: pip install exited with code", pipCode);
            }
          } catch (e) {
            console.warn("  Warning: pip install failed:", e.message);
          }
        } catch {
          // No requirements.txt — skip
        }

        // Run each criterion command
        let allPassed = true;
        for (const cmd of criteriaCommands) {
          try {
            const { exitCode, stdout, stderr } = await execCmd(
              "sh", ["-c", cmd],
              { cwd: worktreePath, timeout: 30_000 }
            );
            const passed = exitCode === 0;
            criteriaResults.push({ command: cmd, passed, exitCode, stdout, stderr });
            if (!passed) allPassed = false;
            console.log(`  Criteria: ${passed ? "PASS" : "FAIL"} \`${cmd}\``);
          } catch (e) {
            criteriaResults.push({ command: cmd, passed: false, exitCode: null, error: e.message });
            allPassed = false;
            console.log(`  Criteria: FAIL \`${cmd}\` (error: ${e.message})`);
          }
        }
        criteriaPass = allPassed;
      } else {
        console.warn("  Warning: no worktreePath on run, skipping criteria");
        criteriaResults.push({ error: "No worktreePath available" });
      }

      // ── Step 2g: diff correctness ────────────────────────────

      let diffStat = null;
      let diffCorrectness = false;
      if (worktreePath) {
        const baseBranch = run.baseBranch || "main";
        try {
          const { stdout: diffOut, exitCode: diffCode } = await execCmd(
            "git", ["-C", worktreePath, "diff", "--stat", `${baseBranch}...HEAD`, "--", ".", ":.ralph"],
            { cwd: worktreePath, timeout: 15_000 }
          );
          if (diffCode === 0) {
            diffStat = diffOut.trim();
            const diffNonEmpty = diffStat.length > 0;
            diffCorrectness = diffNonEmpty && criteriaPass;
          } else {
            diffStat = `git diff exited ${diffCode}`;
            diffCorrectness = false;
          }
        } catch (e) {
          diffStat = `git diff error: ${e.message}`;
          diffCorrectness = false;
        }
      }

      // ── Auto-review ──────────────────────────────────────────
      // Criteria pass → approve (the merge is discarded by the per-run reset).
      // Criteria fail → abandon the card: rejecting would re-queue it and the
      // orchestrator would relaunch its loop mid-benchmark.

      if (auto_review && terminalStatus === "review" && reviewRunId) {
        const decision = criteriaPass ? "approved" : "abandoned";
        const reviewRes = criteriaPass
          ? await fetch(`${base_url}/api/reviews`, {
              method: "POST",
              headers: authHeaders,
              body: JSON.stringify({ runId: reviewRunId, decision: "approved" }),
            })
          : await fetch(`${base_url}/api/cards/${cardId}/abandon`, {
              method: "POST",
              headers: authHeaders,
            });
        if (!reviewRes.ok) {
          const detail = await reviewRes.text().catch(() => "");
          throw new Error(`Auto-review (${decision}) failed: HTTP ${reviewRes.status} ${detail}`);
        }
        reviewOutcome = decision;
        console.log(`  Auto-review: ${decision} (criteria ${criteriaPass ? "passed" : "failed"})`);

        // Approval merges synchronously but also kicks off an async
        // summarize/docs run whose worktree is branched from the just-merged
        // default branch and which later merges docs back into it. Resetting
        // to baseline while that run is in flight resurrects the approved
        // history and dirties the target checkout, so wait for the card's
        // post-approval run to finish before moving on.
        if (decision === "approved") {
          for (;;) {
            const waitRes = await fetch(`${base_url}/api/cards`, { headers: authHeaders });
            await assertOk(waitRes, "GET /api/cards summarize wait");
            const c = (await waitRes.json()).find((x) => x.id === cardId);
            if (!c?.latestRun || c.latestRun.status !== "running") break;
            console.log(`  Waiting for post-approval ${c.latestRun.kind} run to finish...`);
            await sleep(pollIntervalMs);
          }
        }
      }

      // ── Collect per-run result ───────────────────────────────

      runResults.push({
        run: runIdx,
        cardId,
        runId: reviewRunId,
        runCount: cardRuns.length,
        status: terminalStatus,
        reviewOutcome,
        totalWallTimeMs,
        iterationCount,
        totalModelTurns,
        p50IterationTimeMs: p50IterationTime,
        p90IterationTimeMs: p90IterationTime,
        iterationWallTimesMs: iterationWallTimes,
        sumPromptTokens,
        sumCachedInputTokens,
        sumCompletionTokens,
        sumReasoningTokens,
        sumCostUsd,
        costByKind,
        criteriaPass,
        criteriaResults,
        diffStat,
        diffCorrectness,
        worktreePath,
      });
    }

    // ── Step 3: aggregate across runs ──────────────────────────

    const validResults = runResults.filter((r) => !r.error);

    const totalWallTimes = validResults.map((r) => r.totalWallTimeMs).filter((v) => v !== null);
    const iterationCounts = validResults.map((r) => r.iterationCount);
    const modelTurnCounts = validResults.map((r) => r.totalModelTurns);
    const p50Times = validResults.map((r) => r.p50IterationTimeMs).filter((v) => v !== null);
    const p90Times = validResults.map((r) => r.p90IterationTimeMs).filter((v) => v !== null);
    const promptTokens = validResults.map((r) => r.sumPromptTokens);
    const cachedTokens = validResults.map((r) => r.sumCachedInputTokens);
    const completionTokens = validResults.map((r) => r.sumCompletionTokens);
    const reasoningTokens = validResults.map((r) => r.sumReasoningTokens);
    const costs = validResults.map((r) => r.sumCostUsd);
    const criteriaPasses = validResults.map((r) => r.criteriaPass);
    const diffCorrectnesses = validResults.map((r) => r.diffCorrectness);

    const report = {
      meta: {
        fixture,
        seeded: hasSeed,
        baselineSha,
        baseUrl: base_url,
        repo,
        provider,
        model,
        plannerModel: planner_model,
        numRuns,
        maxIterations: max_iterations || null,
        timeoutMinutes: timeout_minutes || null,
        autoReview: !!auto_review,
        timestamp: new Date().toISOString(),
      },
      perRun: runResults,
      aggregated: {
        totalWallTimeMs: computeStats(totalWallTimes),
        iterationCount: computeStats(iterationCounts),
        totalModelTurns: computeStats(modelTurnCounts),
        p50IterationTimeMs: computeStats(p50Times),
        p90IterationTimeMs: computeStats(p90Times),
        sumPromptTokens: computeStats(promptTokens),
        sumCachedInputTokens: computeStats(cachedTokens),
        sumCompletionTokens: computeStats(completionTokens),
        sumReasoningTokens: computeStats(reasoningTokens),
        sumCostUsd: computeStats(costs),
        criteriaPassRate: criteriaPasses.length > 0
          ? criteriaPasses.filter(Boolean).length / criteriaPasses.length
          : null,
        diffCorrectnessRate: diffCorrectnesses.length > 0
          ? diffCorrectnesses.filter(Boolean).length / diffCorrectnesses.length
          : null,
        criteriaPasses,
        diffCorrectnesses,
      },
    };

    // ── Step 4: write output ───────────────────────────────────

    const reportJson = JSON.stringify(report, null, 2);

    if (out) {
      await fsWriteFile(out, reportJson, "utf8");
      console.log(`\nReport written to ${out}`);
    } else {
      console.log("\n" + reportJson);
    }

    // ── Human summary to stdout ────────────────────────────────

    const agg = report.aggregated;
    console.log("\n=== BENCHMARK SUMMARY ===");
    console.log(`Fixture:    ${report.meta.fixture}`);
    console.log(`Loop:       ${report.meta.provider}/${report.meta.model}`);
    console.log(`Planner:    ${report.meta.plannerModel}`);
    console.log(`Runs:       ${numRuns}`);
    console.log(`Criteria pass rate: ${agg.criteriaPassRate !== null ? (agg.criteriaPassRate * 100).toFixed(0) + "%" : "N/A"}`);
    console.log(`Diff correctness:   ${agg.diffCorrectnessRate !== null ? (agg.diffCorrectnessRate * 100).toFixed(0) + "%" : "N/A"}`);
    if (agg.totalWallTimeMs) {
      console.log(`Total wall time:    median ${msToHuman(agg.totalWallTimeMs.median)}`);
    }
    if (agg.iterationCount) {
      console.log(`Iterations:         median ${agg.iterationCount.median}`);
    }
    if (agg.totalModelTurns) {
      console.log(`Model turns:        median ${agg.totalModelTurns.median}`);
    }
    if (agg.p50IterationTimeMs) {
      console.log(`Iteration p50:      ${msToHuman(agg.p50IterationTimeMs.median)}`);
      console.log(`Iteration p90:      ${msToHuman(agg.p90IterationTimeMs.median)}`);
    }
    if (agg.sumCostUsd) {
      console.log(`Cost (USD):         median $${agg.sumCostUsd.median.toFixed(4)}`);
    }
    console.log("========================\n");
  }

  await main().catch(async (err) => {
    console.error("Fatal error:", err.message);
    // Always land a report so the UI shows a failed run instead of a
    // permanently "in progress" one (active = log without report).
    if (out) {
      try {
        const failureReport = {
          meta: {
            fixture,
            baseUrl: base_url,
            repo,
            provider,
            model,
            plannerModel: planner_model,
            numRuns,
            autoReview: !!auto_review,
            timestamp: new Date().toISOString(),
            error: err.message,
          },
        };
        await fsWriteFile(out, JSON.stringify(failureReport, null, 2), "utf8");
        console.error(`Failure report written to ${out}`);
      } catch (writeErr) {
        console.error(`Could not write failure report: ${writeErr.message}`);
      }
    }
    process.exit(1);
  });
}
