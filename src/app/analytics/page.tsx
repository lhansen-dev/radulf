"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../ui/api";
import { BarList } from "../ui/barList";
import { formatCostUsd } from "../ui/formatCost";
import type { AnalyticsResponse } from "../../server/analytics";
import { AppShell } from "../ui/appShell";

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState("");
  const [range, setRange] = useState<"all" | "today" | "7d" | "30d">("all");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");

  useEffect(() => {
    const qs = new URLSearchParams();
    if (range !== "all") qs.set("range", range);
    if (provider) qs.set("provider", provider);
    if (model) qs.set("model", model);
    const query = qs.toString();
    api<AnalyticsResponse>(`/api/analytics${query ? `?${query}` : ""}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [range, provider, model]);

  if (error) {
    return (
      <AppShell><div className="flex min-h-[70dvh] flex-col items-center justify-center gap-3 px-4 text-center text-foreground/70">
        <p className="text-red-400">Failed to load analytics: {error}</p>
        <Link href="/" className="touch-target flex items-center text-sm text-foreground/60 underline">
          Back to Work
        </Link>
      </div></AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell><div className="flex min-h-[70dvh] items-center justify-center text-sm text-foreground/40" aria-label="Loading activity">
        Loading analytics…
      </div></AppShell>
    );
  }

  if (data.totals.cards === 0) {
    return (
      <AppShell><div className="flex min-h-[70dvh] flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-lg font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-foreground/50">No tasks yet — create one to see run metrics.</p>
        <Link href="/" className="touch-target flex items-center text-sm text-foreground/60 underline">
          Back to Work
        </Link>
      </div></AppShell>
    );
  }

  return (
    <AppShell>
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-foreground/10 px-4 py-4 sm:px-6">
        <div className="min-w-full sm:min-w-0 sm:grow">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-foreground/35">Runs and outcomes</p>
          <h1 tabIndex={-1} className="mt-0.5 text-2xl font-semibold tracking-tight">Activity</h1>
        </div>
        <FilterSelect id="activity-range" label="Date range" value={range} onChange={(v) => setRange(v as typeof range)}
          options={[["all", "All time"], ["today", "Today"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]]} />
        <FilterSelect id="activity-provider" label="Provider" value={provider} onChange={setProvider}
          options={[["", "All providers"], ...data.providers.map((p) => [p, p] as const)]} />
        <FilterSelect id="activity-model" label="Model" value={model} onChange={setModel}
          options={[["", "All models"], ...data.models.map((m) => [m, m] as const)]} />
      </header>

      <main className="flex flex-col gap-5 p-4 sm:p-6">
        {/* KPI tiles — "Uncached Input" is cumulative uncached input across
            model turns, deliberately NOT presented as generic total tokens. */}
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
          <KpiTile label="Tasks" value={data.totals.cards.toLocaleString()} />
          <KpiTile label="Runs" value={data.totals.runs.toLocaleString()} />
          <KpiTile label="Iterations" value={data.totals.iterations.toLocaleString()} />
          <KpiTile
            label="Uncached Input"
            value={data.totals.promptTokens.toLocaleString()}
            hint="tokens, summed over model turns"
          />
          <KpiTile
            label="Cost"
            value={formatCostUsd(data.totals.costUsd)}
            hint={
              data.totals.costUsd != null
                ? "USD, as priced by the harness"
                : "no iteration reported a cost"
            }
          />
        </div>

        {/* Loop performance (spec 11 Phase 0) */}
        {data.loopKpis.sampleSize > 0 && (
          <section aria-label="Loop performance">
            <h2 className="mb-3 text-sm font-medium text-foreground/70">
              Loop performance{" "}
              <span className="text-foreground/40">
                (n={data.loopKpis.sampleSize} iterations)
              </span>
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <KpiTile label="p50 duration" value={fmtDuration(data.loopKpis.durationP50Ms)} />
              <KpiTile label="p90 duration" value={fmtDuration(data.loopKpis.durationP90Ms)} />
              <KpiTile label="p95 duration" value={fmtDuration(data.loopKpis.durationP95Ms)} />
              <KpiTile label="Max duration" value={fmtDuration(data.loopKpis.durationMaxMs)} />
              <KpiTile
                label="≥5 min iterations"
                value={fmtPercent(data.loopKpis.slowIterationRate)}
              />
              <KpiTile
                label="Median model turns"
                value={
                  data.loopKpis.medianModelTurns != null
                    ? data.loopKpis.medianModelTurns.toLocaleString()
                    : "—"
                }
                hint={
                  data.loopKpis.modelTurnsSampleSize > 0
                    ? `n=${data.loopKpis.modelTurnsSampleSize}`
                    : "not reported yet"
                }
              />
              <KpiTile
                label="Cache-hit ratio"
                value={fmtPercent(data.loopKpis.cacheHitRatio)}
                hint={
                  data.loopKpis.cacheSampleSize > 0
                    ? `n=${data.loopKpis.cacheSampleSize}`
                    : "not reported yet"
                }
              />
              {/* Cost lives in its own totals tile above — this one is time. */}
              <KpiTile
                label="Tool time"
                value={fmtDuration(data.loopKpis.totalToolDurationMs)}
              />
            </div>
            {data.loopCohorts.length > 0 && (
              <div className="mt-4 rounded-lg border border-foreground/10 bg-foreground/[0.03] p-4">
                <h3 className="mb-3 text-sm font-medium text-foreground/70">
                  Cohorts <span className="text-foreground/40">(actual provider/model/harness, min 10 iterations)</span>
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wider text-foreground/40">
                        <th className="pb-2 pr-4 font-medium">Cohort</th>
                        <th className="pb-2 pr-4 text-right font-medium">n</th>
                        <th className="pb-2 pr-4 text-right font-medium">p50</th>
                        <th className="pb-2 text-right font-medium">p90</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.loopCohorts.map((c) => (
                        <tr key={c.label} className="border-t border-foreground/5 text-foreground/70">
                          <td className="py-2 pr-4">{c.label}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{c.sampleSize}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">
                            {fmtDuration(c.durationP50Ms)}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {fmtDuration(c.durationP90Ms)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

        {/* No-runs empty state */}
        {data.totals.runs === 0 && data.totals.cards > 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <p className="text-foreground/50 text-sm">No runs match the current filters.</p>
            <button
              onClick={() => {
                setRange("all");
                setProvider("");
                setModel("");
              }}
              className="text-foreground/60 hover:text-foreground text-sm underline cursor-pointer"
            >
              Reset filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {([
              ["Tasks by Status", data.cardsByStatus],
              ["Runs by Status", data.runsByStatus],
              ["Tokens per Run", data.tokensPerRun],
              ["Cost per Run", data.costPerRun, formatCostUsd],
            ] as const).map(([title, bars, format]) => (
              <ChartSection key={title} title={title}><BarList data={bars} format={format} /></ChartSection>
            ))}
            <ChartSection title="Success Rate">
              <div className="flex items-center gap-3">
                <div className="flex-1 h-5 bg-foreground/[0.06] rounded overflow-hidden">
                  <div className="h-full bg-amber-500/70 rounded" style={{ width: fmtPercent(data.successRate) }} />
                </div>
                <span className="w-16 shrink-0 text-right text-sm text-foreground/70 tabular-nums">{fmtPercent(data.successRate)}</span>
              </div>
            </ChartSection>
            {([
              ["Tokens by Model", data.tokensByModel],
              ["Cost by Model", data.costByModel, formatCostUsd],
              ["Tokens by Role", data.tokensByRole, undefined, "planner / loop / evaluator"],
              ["Cost by Role", data.costByRole, formatCostUsd, "planner / loop / evaluator"],
              ["Runs by Provider", data.runsByProvider],
            ] as const).map(([title, bars, format, hint]) => (
              <ChartSection key={title} title={title} hint={hint}><BarList data={bars} format={format} /></ChartSection>
            ))}
          </div>
        )}
      </main>
    </div>
    </AppShell>
  );
}

function KpiTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-foreground/10 bg-foreground/[0.03] p-3 sm:p-4">
      <p className="text-xs text-foreground/50 uppercase tracking-wider">{label}</p>
      <p className="mt-1 truncate text-xl font-semibold tabular-nums text-foreground/90 sm:text-2xl">
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-xs text-foreground/40">{hint}</p>}
    </div>
  );
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

function fmtPercent(ratio: number | null): string {
  if (ratio == null) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

function FilterSelect({ id, label, value, onChange, options }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
}) {
  return (
    <>
      <label className="sr-only" htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-36 grow rounded-lg border border-foreground/10 bg-foreground/5 px-3 text-sm text-foreground/70 sm:grow-0"
      >
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </>
  );
}

function ChartSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-foreground/[0.03] border border-foreground/10 p-4">
      <h3 className="text-sm font-medium text-foreground/70 mb-3">
        {title}
        {hint && <span className="ml-2 font-normal text-foreground/40">{hint}</span>}
      </h3>
      {children}
    </div>
  );
}
