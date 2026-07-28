"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../ui/api";
import type { Repo } from "../ui/api";
import { AppShell } from "../ui/appShell";
import type { BenchmarksResponse } from "../api/benchmarks/route";
import type { RolloutTarget } from "../../server/analytics";

export default function BenchmarksPage() {
  const [data, setData] = useState<BenchmarksResponse | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [error, setError] = useState("");

  const [fixture, setFixture] = useState("");
  const [repoId, setRepoId] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [plannerModel, setPlannerModel] = useState("");
  const [runs, setRuns] = useState(3);
  const [autoReview, setAutoReview] = useState(true);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(() => {
    api<BenchmarksResponse>("/api/benchmarks")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    refresh();
    api<Repo[]>("/api/repos").then(setRepos).catch(() => {});
    api<{ plannerModel?: string; loopProvider?: string; loopModel?: string }>("/api/settings")
      .then((s) => {
        setProvider((p) => p || s.loopProvider || "");
        setModel((m) => m || s.loopModel || "");
        setPlannerModel((m) => m || s.plannerModel || "");
      })
      .catch(() => {});
  }, [refresh]);

  // While a benchmark is running its report hasn't landed — poll for progress.
  useEffect(() => {
    if (!data || data.active.length === 0) return;
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [data, refresh]);

  async function start() {
    setStarting(true);
    setNotice("");
    setError("");
    try {
      const res = await api<{ reportFile: string; logFile: string }>("/api/benchmarks", {
        json: { fixture, repoId, provider, model, plannerModel, runs, autoReview },
      });
      setNotice(`Benchmark started — report will land in benchmarks/reports/${res.reportFile}`);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  if (!data) {
    return (
      <AppShell><div className="flex min-h-[70dvh] items-center justify-center text-sm text-foreground/40" aria-label="Loading benchmarks">
        {error ? `Failed to load benchmarks: ${error}` : "Loading benchmarks…"}
      </div></AppShell>
    );
  }

  const rollout = data.rollout;
  const canStart = fixture && repoId && provider && model && !starting;

  return (
    <AppShell>
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col">
      <header className="border-b border-foreground/10 px-4 py-4 sm:px-6">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-foreground/35">Loop performance evidence</p>
        <h1 tabIndex={-1} className="mt-0.5 text-2xl font-semibold tracking-tight">Benchmarks</h1>
      </header>

      <main className="flex flex-col gap-5 p-4 sm:p-6">
        {error && <p className="text-sm text-red-400">{error}</p>}
        {notice && <p className="text-sm text-emerald-400">{notice}</p>}

        {/* Rollout acceptance (spec 11) */}
        <section aria-label="Rollout acceptance" className="rounded-lg border border-foreground/10 bg-foreground/[0.03] p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-medium text-foreground/70">
              Rollout acceptance{" "}
              <span className="text-foreground/40">
                (most recent {rollout.windowSize} of {rollout.requiredSampleSize} required iterations)
              </span>
            </h2>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                rollout.accepted === true
                  ? "bg-emerald-500/15 text-emerald-400"
                  : rollout.accepted === false
                    ? "bg-red-500/15 text-red-400"
                    : "bg-foreground/10 text-foreground/50"
              }`}
            >
              {rollout.accepted === true
                ? "Targets met"
                : rollout.accepted === false
                  ? "Targets missed"
                  : rollout.sufficientSample
                    ? "Not yet measurable"
                    : "Insufficient sample"}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-foreground/40">
                  <th className="pb-2 pr-4 font-medium">Target</th>
                  <th className="pb-2 pr-4 text-right font-medium">Measured</th>
                  <th className="pb-2 pr-4 text-right font-medium">Threshold</th>
                  <th className="pb-2 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rollout.targets.map((t) => (
                  <tr key={t.key} className="border-t border-foreground/5 text-foreground/70">
                    <td className="py-2 pr-4">{t.label}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{fmtTargetValue(t, t.actual)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {t.comparison === "under" ? "< " : "≤ "}
                      {fmtTargetValue(t, t.target)}
                    </td>
                    <td className="py-2 text-right">
                      {t.pass === true ? (
                        <span className="text-emerald-400">pass</span>
                      ) : t.pass === false ? (
                        <span className="text-red-400">miss</span>
                      ) : (
                        <span className="text-foreground/40">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-foreground/40">
            Spec 11 also requires no regression in criteria-pass / review-approval rate versus the
            baseline cohort — compare cohorts on the <Link href="/analytics" className="underline">Activity</Link> screen.
          </p>
        </section>

        {/* Launch a benchmark */}
        <section aria-label="Run a benchmark" className="rounded-lg border border-foreground/10 bg-foreground/[0.03] p-4">
          <h2 className="mb-1 text-sm font-medium text-foreground/70">Run a benchmark</h2>
          <p className="mb-3 text-xs text-foreground/40">
            Runs the shared runner against a fixture. Use a throwaway repo: seeded fixtures commit
            their seed into it and every run hard-resets to the pre-benchmark baseline. Parallel
            loops are disabled for the duration and restored afterwards.
          </p>
          <div className="flex flex-wrap gap-3">
            <label className="sr-only" htmlFor="bench-fixture">Fixture</label>
            <select
              id="bench-fixture"
              value={fixture}
              onChange={(e) => setFixture(e.target.value)}
              className="min-w-44 grow rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground/70 sm:grow-0"
            >
              <option value="">Fixture…</option>
              {data.fixtures.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}{f.seeded ? " (seeded)" : ""}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="bench-repo">Repo</label>
            <select
              id="bench-repo"
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              className="min-w-44 grow rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground/70 sm:grow-0"
            >
              <option value="">Throwaway repo…</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <label className="sr-only" htmlFor="bench-provider">Loop provider</label>
            <input
              id="bench-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="loop provider"
              className="w-36 rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground/70"
            />
            <label className="sr-only" htmlFor="bench-model">Loop model</label>
            <input
              id="bench-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="loop model"
              className="w-56 rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground/70"
            />
            <label className="sr-only" htmlFor="bench-planner-model">Planner model</label>
            <input
              id="bench-planner-model"
              value={plannerModel}
              onChange={(e) => setPlannerModel(e.target.value)}
              placeholder="planner model (defaults to loop)"
              title="Uses the planner provider configured in Settings"
              className="w-64 rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground/70"
            />
            <label className="flex items-center gap-2 text-sm text-foreground/60" htmlFor="bench-runs">
              Runs
              <input
                id="bench-runs"
                type="number"
                min={1}
                max={10}
                value={runs}
                onChange={(e) => setRuns(Number(e.target.value))}
                className="w-16 rounded-lg border border-foreground/10 bg-foreground/5 px-2 py-2 text-sm text-foreground/70"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground/60">
              <input
                type="checkbox"
                checked={autoReview}
                onChange={(e) => setAutoReview(e.target.checked)}
              />
              Auto-review
            </label>
            <button
              type="button"
              disabled={!canStart}
              onClick={start}
              className="rounded-lg bg-amber-500/80 px-4 py-2 text-sm font-medium text-on-accent hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {starting ? "Starting…" : "Start benchmark"}
            </button>
          </div>
        </section>

        {/* In-progress runs */}
        {data.active.length > 0 && (
          <section aria-label="Benchmarks in progress" className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-4">
            <h2 className="mb-2 text-sm font-medium text-foreground/70">In progress</h2>
            {data.active.map((a) => (
              <div key={a.logFile} className="border-t border-foreground/5 py-2 text-sm text-foreground/60 first:border-t-0">
                <span className="font-medium text-foreground/80">{a.logFile}</span>
                <span className="ml-2 text-xs text-foreground/40">started {new Date(a.startedAt).toLocaleString()}</span>
                {a.lastLine && <div className="mt-1 truncate font-mono text-xs text-foreground/40">{a.lastLine}</div>}
              </div>
            ))}
          </section>
        )}

        {/* Reports */}
        <section aria-label="Benchmark reports" className="rounded-lg border border-foreground/10 bg-foreground/[0.03] p-4">
          <h2 className="mb-3 text-sm font-medium text-foreground/70">
            Reports <span className="text-foreground/40">(benchmarks/reports/)</span>
          </h2>
          {data.reports.length === 0 ? (
            <p className="text-sm text-foreground/40">No reports yet — run a benchmark above or via the CLI runner.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-foreground/40">
                    <th className="pb-2 pr-4 font-medium">Fixture</th>
                    <th className="pb-2 pr-4 font-medium">Loop / planner</th>
                    <th className="pb-2 pr-4 text-right font-medium">Runs</th>
                    <th className="pb-2 pr-4 text-right font-medium">Criteria pass</th>
                    <th className="pb-2 pr-4 text-right font-medium">Diff correct</th>
                    <th className="pb-2 pr-4 text-right font-medium">Median wall</th>
                    <th className="pb-2 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.reports.map((r) => (
                    <tr key={r.file} className="border-t border-foreground/5 text-foreground/70">
                      <td className="py-2 pr-4">
                        {r.fixture ?? r.file}
                        {r.error && <div className="mt-0.5 text-xs text-red-400">failed: {r.error}</div>}
                      </td>
                      <td className="py-2 pr-4">
                        <div>{r.provider ?? "—"} / {r.model ?? "—"}</div>
                        <div className="text-xs text-foreground/40">planner: {r.plannerModel ?? "—"}</div>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.numRuns ?? "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{fmtRate(r.criteriaPassRate)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{fmtRate(r.diffCorrectnessRate)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{fmtMs(r.medianWallTimeMs)}</td>
                      <td className="py-2 text-right text-xs text-foreground/40">
                        {r.timestamp ? new Date(r.timestamp).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Corpus */}
        <section aria-label="Fixture corpus" className="rounded-lg border border-foreground/10 bg-foreground/[0.03] p-4">
          <h2 className="mb-3 text-sm font-medium text-foreground/70">
            Fixture corpus <span className="text-foreground/40">(benchmarks/)</span>
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.fixtures.map((f) => (
              <div key={f.name} className="rounded-lg border border-foreground/10 bg-foreground/[0.02] p-3">
                <p className="text-sm font-medium text-foreground/80">{f.name}</p>
                <p className="mt-0.5 text-sm text-foreground/50">{f.title}</p>
                <p className="mt-1 text-xs text-foreground/40">
                  {f.criteriaCount} machine-checkable criteria · {f.seeded ? "seeded existing-codebase" : "greenfield"}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
    </AppShell>
  );
}

function fmtTargetValue(t: RolloutTarget, value: number | null): string {
  if (value == null) return "—";
  if (t.unit === "ms") {
    const s = value / 1000;
    return s < 60 ? `${s.toFixed(0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }
  if (t.unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString();
}

function fmtRate(ratio: number | null): string {
  if (ratio == null) return "—";
  return `${(ratio * 100).toFixed(0)}%`;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}
