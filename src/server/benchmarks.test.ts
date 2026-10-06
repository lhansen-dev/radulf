import { afterEach, describe, it, expect, vi } from "vitest";
import { launchBenchmark, listFixtures, summarizeReport } from "./benchmarks";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 99),
  closeSync: vi.fn(),
}));

describe("listFixtures", () => {
  // Runs against the real benchmarks/ directory — the corpus is part of the repo.
  it("finds the four corpus fixtures with titles and criteria", () => {
    const fixtures = listFixtures();
    const names = fixtures.map((f) => f.name);

    expect(names).toEqual([
      "failing-test-repair",
      "server-data-change",
      "small-ui-change",
      "snake-tui",
    ]);
    for (const f of fixtures) {
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.criteriaCount).toBeGreaterThan(0);
      // Existing-codebase fixtures are seeded; snake-tui is greenfield.
      expect(f.seeded).toBe(f.name !== "snake-tui");
    }
  });

  it("returns an empty list for a missing directory", () => {
    expect(listFixtures("/nonexistent/benchmarks")).toEqual([]);
  });
});

describe("summarizeReport", () => {
  it("extracts meta and aggregated medians from a runner report", () => {
    const summary = summarizeReport("f.json", {
      meta: {
        fixture: "snake-tui",
        provider: "openrouter",
        model: "some/model",
        plannerModel: "planner/model",
        numRuns: 3,
        timestamp: "2026-07-15T00:00:00.000Z",
      },
      aggregated: {
        totalWallTimeMs: { median: 120000 },
        iterationCount: { median: 8 },
        totalModelTurns: { median: 90 },
        sumCostUsd: { median: 1.25 },
        criteriaPassRate: 1,
        diffCorrectnessRate: 2 / 3,
      },
    });

    expect(summary).toEqual({
      file: "f.json",
      fixture: "snake-tui",
      provider: "openrouter",
      model: "some/model",
      plannerModel: "planner/model",
      evaluatorModel: null,
      planCritic: null,
      criticModel: null,
      numRuns: 3,
      timestamp: "2026-07-15T00:00:00.000Z",
      error: null,
      criteriaPassRate: 1,
      diffCorrectnessRate: 2 / 3,
      medianWallTimeMs: 120000,
      medianIterations: 8,
      medianModelTurns: 90,
      medianCostUsd: 1.25,
    });
  });

  it("reads the evaluator and plan critic the runs used", () => {
    const summary = summarizeReport("roles.json", {
      meta: { model: "m", evaluatorModel: "eval/model", planCritic: true, criticModel: "critic/model" },
    });
    expect(summary).toMatchObject({ evaluatorModel: "eval/model", planCritic: true, criticModel: "critic/model" });
  });

  it("uses the loop model as the planner for legacy reports", () => {
    const summary = summarizeReport("legacy.json", {
      meta: { model: "one/model" },
    });
    expect(summary.plannerModel).toBe("one/model");
  });

  it("tolerates a malformed or empty report", () => {
    const summary = summarizeReport("bad.json", null);
    expect(summary.file).toBe("bad.json");
    expect(summary.fixture).toBeNull();
    expect(summary.criteriaPassRate).toBeNull();
    expect(summary.medianWallTimeMs).toBeNull();
    expect(summary.error).toBeNull();
  });

  it("surfaces the runner's fatal error from a failure report", () => {
    const summary = summarizeReport("failed.json", {
      meta: {
        fixture: "snake-tui",
        provider: "openrouter",
        model: "some/model",
        numRuns: 3,
        timestamp: "2026-07-15T00:00:00.000Z",
        error: "git checkout -q main exited 1",
      },
    });
    expect(summary.fixture).toBe("snake-tui");
    expect(summary.error).toBe("git checkout -q main exited 1");
    expect(summary.criteriaPassRate).toBeNull();
  });
});

describe("launchBenchmark", () => {
  const opts = {
    fixture: "snake-tui",
    repoId: "repo-1",
    provider: "openrouter",
    model: "some/model",
    baseUrl: "http://localhost:3000",
  };
  const runnerEnv = () => (spawn.mock.calls.at(-1) as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;

  afterEach(() => {
    vi.unstubAllEnvs();
    spawn.mockClear();
  });

  // With auth disabled the browser never logs in, so there is no cookie to
  // forward — and none is needed, since the proxy admits loopback requests.
  it("launches without a cookie when auth is disabled", () => {
    vi.stubEnv("RADULF_AUTH_PASSWORD_HASH", "");
    launchBenchmark({ ...opts, cookie: "" });
    expect(spawn).toHaveBeenCalledOnce();
    expect(runnerEnv()).not.toHaveProperty("RADULF_BENCH_AUTH_COOKIE");
  });

  it("requires a cookie when auth is enabled", () => {
    vi.stubEnv("RADULF_AUTH_PASSWORD_HASH", "$2b$hash");
    expect(() => launchBenchmark({ ...opts, cookie: "" })).toThrow("missing session cookie");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes the evaluator, critic, and plan critic choice to the runner", () => {
    vi.stubEnv("RADULF_AUTH_PASSWORD_HASH", "");
    launchBenchmark({ ...opts, cookie: "", evaluatorModel: "eval/m", criticModel: "critic/m", planCritic: false });
    const args = (spawn.mock.calls.at(-1) as unknown as [string, string[]])[1];
    expect(args.join(" ")).toContain("--evaluator-model eval/m --critic-model critic/m --plan-critic off");
  });

  it("forwards the cookie through the environment", () => {
    vi.stubEnv("RADULF_AUTH_PASSWORD_HASH", "$2b$hash");
    launchBenchmark({ ...opts, cookie: "radulf_session=abc" });
    expect(runnerEnv().RADULF_BENCH_AUTH_COOKIE).toBe("radulf_session=abc");
  });
});
