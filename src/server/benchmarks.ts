import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { ClientError } from "./clientError";

const BENCH_DIR = path.join(process.cwd(), "benchmarks");
const REPORTS_DIR = path.join(BENCH_DIR, "reports");

export type BenchmarkFixture = {
  name: string;
  /** First line of TASK.md — the card title the planner receives. */
  title: string;
  criteriaCount: number;
  /** Existing-codebase fixtures ship a seed/ directory. */
  seeded: boolean;
};

/** Compact summary of one runner report JSON in benchmarks/reports/. */
export type BenchmarkReport = {
  file: string;
  fixture: string | null;
  provider: string | null;
  model: string | null;
  plannerModel: string | null;
  numRuns: number | null;
  timestamp: string | null;
  /** Set when the runner died before completing — the fatal error message. */
  error: string | null;
  criteriaPassRate: number | null;
  diffCorrectnessRate: number | null;
  medianWallTimeMs: number | null;
  medianIterations: number | null;
  medianModelTurns: number | null;
  medianCostUsd: number | null;
};

/** A runner launched from the UI whose report has not landed yet. */
export type ActiveBenchmark = {
  logFile: string;
  startedAt: string;
  lastLine: string;
};

export function listFixtures(dir = BENCH_DIR): BenchmarkFixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "TASK.md")))
    .map((e) => {
      const fixtureDir = path.join(dir, e.name);
      const task = readFileSync(path.join(fixtureDir, "TASK.md"), "utf8");
      const criteriaPath = path.join(fixtureDir, "CRITERIA.md");
      const criteria = existsSync(criteriaPath) ? readFileSync(criteriaPath, "utf8") : "";
      return {
        name: e.name,
        title: task.trimStart().split("\n")[0].trim(),
        criteriaCount: criteria.split("\n").filter((l) => /^-\s*`[^`]+`\s+(?:exits 0|succeeds)/.test(l)).length,
        seeded: existsSync(path.join(fixtureDir, "seed")),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reduce a full runner report to the row the Benchmarks page shows. */
export function summarizeReport(file: string, report: unknown): BenchmarkReport {
  const r = (report ?? {}) as {
    meta?: Record<string, unknown>;
    aggregated?: Record<string, { median?: number } | number | null>;
  };
  const meta = r.meta ?? {};
  const agg = r.aggregated ?? {};
  const medianOf = (key: string): number | null => {
    const v = agg[key];
    if (v == null) return null;
    if (typeof v === "number") return v;
    return typeof v.median === "number" ? v.median : null;
  };
  const rate = (key: string): number | null => {
    const v = agg[key];
    return typeof v === "number" ? v : null;
  };
  const str = (key: string): string | null =>
    typeof meta[key] === "string" ? (meta[key] as string) : null;
  const model = str("model");
  return {
    file,
    fixture: str("fixture"),
    provider: str("provider"),
    model,
    // Reports written before planner selection was added always used the
    // loop model for planning, so retain that fact in their summaries.
    plannerModel: str("plannerModel") ?? model,
    numRuns: typeof meta.numRuns === "number" ? meta.numRuns : null,
    timestamp: str("timestamp"),
    error: str("error"),
    criteriaPassRate: rate("criteriaPassRate"),
    diffCorrectnessRate: rate("diffCorrectnessRate"),
    medianWallTimeMs: medianOf("totalWallTimeMs"),
    medianIterations: medianOf("iterationCount"),
    medianModelTurns: medianOf("totalModelTurns"),
    medianCostUsd: medianOf("sumCostUsd"),
  };
}

export function listReports(dir = REPORTS_DIR): BenchmarkReport[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return summarizeReport(f, JSON.parse(readFileSync(path.join(dir, f), "utf8")));
      } catch {
        return summarizeReport(f, null);
      }
    })
    .sort((a, b) => (b.timestamp ?? b.file).localeCompare(a.timestamp ?? a.file));
}

export function listActiveBenchmarks(dir = REPORTS_DIR): ActiveBenchmark[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".log") && !existsSync(path.join(dir, f.replace(/\.log$/, ".json"))))
    .map((f) => {
      const full = path.join(dir, f);
      const lines = readFileSync(full, "utf8").trimEnd().split("\n");
      return {
        logFile: f,
        startedAt: statSync(full).birthtime.toISOString(),
        lastLine: lines[lines.length - 1] ?? "",
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export type LaunchBenchmarkOptions = {
  fixture: string;
  repoId: string;
  provider: string;
  model: string;
  /** Optional for compatibility with callers that want one model for both roles. */
  plannerModel?: string;
  runs?: number;
  maxIterations?: number;
  timeoutMinutes?: number;
  autoReview?: boolean;
  /** The caller's Cookie header — forwarded so the runner can use the API. */
  cookie: string;
  baseUrl: string;
};

/** Spawn the shared runner detached; stdout/stderr stream to a log next to
 * the report so the page can show progress and surface the result. */
export function launchBenchmark(opts: LaunchBenchmarkOptions): { reportFile: string; logFile: string } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.fixture)) {
    throw new ClientError("invalid fixture name");
  }
  if (!listFixtures().some((f) => f.name === opts.fixture)) {
    throw new ClientError(`unknown fixture: ${opts.fixture}`);
  }
  if (!opts.repoId) throw new ClientError("repoId is required");
  if (!opts.provider || !opts.model) throw new ClientError("provider and model are required");
  if (!opts.cookie) throw new ClientError("missing session cookie");

  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${opts.fixture}-${stamp}`;
  const reportPath = path.join(REPORTS_DIR, `${base}.json`);
  const logPath = path.join(REPORTS_DIR, `${base}.log`);

  const args = [
    path.join(BENCH_DIR, "run-benchmark.mjs"),
    "--fixture", opts.fixture,
    "--repo", opts.repoId,
    "--provider", opts.provider,
    "--model", opts.model,
    "--runs", String(opts.runs ?? 3),
    "--auth-cookie", opts.cookie,
    "--base-url", opts.baseUrl,
    "--out", reportPath,
  ];
  if (opts.plannerModel) args.push("--planner-model", opts.plannerModel);
  if (opts.maxIterations) args.push("--max-iterations", String(opts.maxIterations));
  if (opts.timeoutMinutes) args.push("--timeout-minutes", String(opts.timeoutMinutes));
  if (opts.autoReview) args.push("--auto-review");

  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  return { reportFile: `${base}.json`, logFile: `${base}.log` };
}
