"use client";
import { useCallback, useEffect, useState } from "react";
import { api, type Repo } from "../ui/api";
import { inputCls, secondaryButtonCls, sectionCls } from "./settingsUI";
import type { ScheduleKind } from "@/db/schema";
import { errorMessage } from "@/shared/errorMessage";

/** One row of GET /api/schedules. */
type Schedule = {
  id: string;
  kind: ScheduleKind;
  repoId: string | null;
  cron: string;
  enabled: number;
  config: string;
  lastFiredAt: string | null;
  lastResult: string | null;
  lastError: string | null;
  /** The next few times it will fire, which is how the expression reads back. */
  upcoming: string[];
};

const KIND_LABEL: Record<ScheduleKind, string> = {
  "queue-drain": "Drain the queue",
  "improvement-run": "Start an improvement run",
};

const EXAMPLES = [
  { cron: "0 3 * * *", label: "every day at 03:00" },
  { cron: "0 2 * * 1-5", label: "weekdays at 02:00" },
  { cron: "0 */4 * * *", label: "every four hours" },
  { cron: "30 22 * * sun", label: "Sundays at 22:30" },
];

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Scheduled work (spec 22).
 *
 * Nothing here starts anything a button cannot already start: a drain presses
 * Start on every queued card, and an improvement-run schedule opens a run
 * with the arguments stored on it. Empty by default — a schedule exists only
 * because the operator wrote one.
 */
export function SchedulesSection({ repos }: { repos: Repo[] }) {
  const [rows, setRows] = useState<Schedule[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const refetch = useCallback(() => {
    api<Schedule[]>("/api/schedules")
      .then(setRows)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(refetch, [refetch]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const repoName = (id: string | null) =>
    id ? repos.find((repo) => repo.id === id)?.name ?? id : "every repository";

  return (
    <section id="schedules" className={sectionCls}>
      <div>
        <h3 className="text-base font-semibold">Schedules</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-foreground/55">
          Work the queue, or start an improvement run, on a cron. A schedule starts only what its
          button starts, and every firing lands on the board as an event. A tick the server was
          down for is missed rather than replayed.
        </p>
      </div>

      {rows === null ? (
        <p className="text-sm text-foreground/50">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-foreground/50">
          Nothing is scheduled. Radulf starts work only when you do.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-2 rounded-lg border border-foreground/10 p-3">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium">{KIND_LABEL[row.kind]}</span>
                <span className="text-xs text-foreground/50">{repoName(row.repoId)}</span>
                <code className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-xs">{row.cron}</code>
                {!row.enabled && <span className="text-xs text-foreground/40">suspended</span>}
              </div>
              {row.upcoming.length > 0 && (
                <p className="text-xs text-foreground/50">
                  Next {fmt(row.upcoming[0])}
                  {row.upcoming.length > 1 && `, then ${row.upcoming.slice(1).map(fmt).join(", ")}`}
                </p>
              )}
              {row.enabled === 1 && row.upcoming.length === 0 && (
                <p className="text-xs text-amber-300">
                  This expression never matches, so it will never fire.
                </p>
              )}
              {row.kind === "improvement-run" && <ConfigLine config={row.config} />}
              {row.lastFiredAt && (
                <p className={`text-xs ${row.lastError ? "text-red-300" : "text-foreground/45"}`}>
                  Last fired {fmt(row.lastFiredAt)} · {row.lastError ?? row.lastResult ?? "no result recorded"}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(() => api(`/api/schedules/${row.id}`, { method: "PATCH", json: { enabled: !row.enabled } }))}
                  className={secondaryButtonCls}
                >
                  {row.enabled ? "Suspend" : "Resume"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(`Delete this schedule? ${KIND_LABEL[row.kind]} on ${row.cron}.`)) return;
                    void act(() => api(`/api/schedules/${row.id}`, { method: "DELETE" }));
                  }}
                  className={`${secondaryButtonCls} text-red-300`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <AddSchedule
          repos={repos}
          busy={busy}
          onCancel={() => setAdding(false)}
          onCreate={async (body) => {
            await act(() => api("/api/schedules", { json: body }));
            setAdding(false);
          }}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`${secondaryButtonCls} self-start`}>
          Add a schedule
        </button>
      )}

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </section>
  );
}

/** An improvement-run schedule's stored arguments, as one readable line. */
function ConfigLine({ config }: { config: string }) {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(config) as Record<string, unknown>;
  } catch {
    return null;
  }
  const parts = [
    parsed.baseBranch ? `off ${parsed.baseBranch}` : null,
    parsed.budgetMinutes ? `${parsed.budgetMinutes} minute budget` : null,
    parsed.focusPrompt ? `focus: ${parsed.focusPrompt}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? <p className="text-xs text-foreground/50">{parts.join(" · ")}</p> : null;
}

function AddSchedule({
  repos,
  busy,
  onCancel,
  onCreate,
}: {
  repos: Repo[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [kind, setKind] = useState<ScheduleKind>("queue-drain");
  const [repoId, setRepoId] = useState("");
  const [cron, setCron] = useState("0 3 * * *");
  const [baseBranch, setBaseBranch] = useState("");
  const [budgetMinutes, setBudgetMinutes] = useState("90");
  const [focusPrompt, setFocusPrompt] = useState("");
  const run = kind === "improvement-run";
  const repo = repos.find((r) => r.id === repoId);

  const submit = () =>
    void onCreate({
      kind,
      repoId: repoId || null,
      cron,
      config: run
        ? {
            baseBranch: baseBranch || repo?.defaultBranch || "",
            budgetMinutes: Number(budgetMinutes),
            ...(focusPrompt.trim() ? { focusPrompt: focusPrompt.trim() } : {}),
          }
        : {},
    });

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-foreground/15 p-3">
      <label className="block text-sm text-foreground/70">
        What to start
        <select value={kind} onChange={(e) => setKind(e.target.value as ScheduleKind)} className={inputCls}>
          <option value="queue-drain">{KIND_LABEL["queue-drain"]}</option>
          <option value="improvement-run">{KIND_LABEL["improvement-run"]}</option>
        </select>
      </label>

      <label className="block text-sm text-foreground/70">
        Repository
        <select value={repoId} onChange={(e) => setRepoId(e.target.value)} className={inputCls}>
          {!run && <option value="">Every repository</option>}
          {run && <option value="">Pick one…</option>}
          {repos.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </label>

      <label className="block text-sm text-foreground/70">
        When, as a cron expression
        <input value={cron} onChange={(e) => setCron(e.target.value)} className={`${inputCls} font-mono`} />
      </label>
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example.cron}
            type="button"
            onClick={() => setCron(example.cron)}
            className="rounded-full border border-foreground/15 px-2.5 py-1 text-xs text-foreground/60 hover:text-foreground"
          >
            {example.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-foreground/45">
        Five fields, in this machine&rsquo;s time zone: minute, hour, day of month, month, day of
        week. The times it will fire are shown once it is saved.
      </p>

      {run && (
        <>
          <label className="block text-sm text-foreground/70">
            Base branch
            <input
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder={repo?.defaultBranch ?? "main"}
              className={inputCls}
            />
          </label>
          <label className="block text-sm text-foreground/70">
            Time budget, in minutes
            <input
              type="number"
              min={1}
              value={budgetMinutes}
              onChange={(e) => setBudgetMinutes(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block text-sm text-foreground/70">
            Focus, optional
            <input
              value={focusPrompt}
              onChange={(e) => setFocusPrompt(e.target.value)}
              placeholder="What the run should look at"
              className={inputCls}
            />
          </label>
        </>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !cron.trim() || (run && !repoId)}
          className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-on-accent disabled:opacity-40"
        >
          Save schedule
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={secondaryButtonCls}>
          Cancel
        </button>
      </div>
    </div>
  );
}
