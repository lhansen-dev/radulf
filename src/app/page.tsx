"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AppShell } from "./ui/appShell";
import {
  api,
  timeAgo,
  type BoardCard,
  type CardStatus,
  type ImprovementRun,
  type Repo,
} from "./ui/api";
import { NewTaskDialog } from "./ui/newTaskDialog";
import { ImprovementRunDialog } from "./ui/improvementRunDialog";
import { DetailsMenu } from "./ui/detailsMenu";
import { useWorkData } from "./ui/useWorkData";
import { useNow } from "./ui/useNow";

type View = "overview" | "needs" | "active" | "queue" | "backlog" | "done";

const views: { key: View; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "needs", label: "Needs you" },
  { key: "active", label: "Active" },
  { key: "queue", label: "Queue" },
  { key: "backlog", label: "Backlog" },
  { key: "done", label: "Done" },
];

const activeStatuses: CardStatus[] = ["planning", "ready", "looping", "evaluating", "paused", "reviewing"];

function statusDetails(card: BoardCard): { mark: string; label: string; detail: string; tone: string } {
  switch (card.status) {
    case "backlog":
      return { mark: "○", label: "Backlog", detail: "Not scheduled", tone: "text-foreground/45" };
    case "todo":
      return { mark: "◎", label: "Queued", detail: "Waiting for auto-mode", tone: "text-slate-300" };
    case "planning":
      return { mark: "◔", label: "Planning", detail: `${timeAgo(card.latestRun?.startedAt ?? card.startedAt)} elapsed`, tone: "text-amber-300" };
    case "ready":
      return { mark: "◇", label: "Ready", detail: "Queued for loop", tone: "text-amber-200" };
    case "looping":
      return { mark: "●", label: "Running", detail: `Iteration ${card.latestRun?.iterationsDone ?? 0}/${card.maxIterationsResolved} · ${timeAgo(card.latestRun?.startedAt ?? card.startedAt)} elapsed`, tone: "text-amber-300" };
    case "evaluating":
      return { mark: "🔎", label: "Evaluating", detail: "Evaluator reviewing the loop's work", tone: "text-amber-300" };
    case "paused":
      return { mark: "⏸", label: "Paused", detail: "Paused after iteration " + (card.latestRun?.iterationsDone ?? 0), tone: "text-sky-300" };
    case "plan_review":
      return { mark: "◉", label: "Plan ready for review", detail: "Plan generated — approve to implement", tone: "text-cyan-300" };
    case "review":
      return { mark: "◆", label: "Ready for review", detail: "Diff ready", tone: "text-violet-300" };
    case "reviewing":
      return { mark: "◌", label: "Applying review", detail: "Finalizing the decision", tone: "text-violet-300" };
    case "needs_attention":
      return { mark: "!", label: "Needs attention", detail: card.latestRun?.exitReason || "Run needs a decision", tone: "text-red-300" };
    case "done":
      return { mark: "✓", label: "Completed", detail: `${timeAgo(card.updatedAt)} ago`, tone: "text-green-300" };
    default:
      return { mark: "—", label: "Abandoned", detail: "No longer active", tone: "text-foreground/35" };
  }
}

export default function WorkPage() {
  const {
    cards,
    setCards,
    repos,
    error,
    setError,
    loading,
    streamConnected,
    autoMode,
    setAutoMode,
    autoApprove,
    setAutoApprove,
    improvementRuns,
    improvementAlert,
    dismissImprovementAlert,
    restartRequired,
    restarting,
    setRestarting,
    refetch,
  } = useWorkData();
  const [repoFilter, setRepoFilter] = useState("");
  const [view, setView] = useState<View>("overview");
  const [showNew, setShowNew] = useState(false);
  const [showImprovementRun, setShowImprovementRun] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const readUrl = () => {
      const query = new URLSearchParams(window.location.search);
      const urlRepo = query.get("repo");
      const urlView = query.get("view") as View | null;
      setRepoFilter(urlRepo ?? localStorage.getItem("radulf.repo") ?? "");
      setView(views.some((item) => item.key === urlView) ? urlView! : "overview");
    };
    readUrl();
    window.addEventListener("popstate", readUrl);
    return () => window.removeEventListener("popstate", readUrl);
  }, []);

  const updateScope = useCallback((repo: string, nextView: View) => {
    setRepoFilter(repo);
    setView(nextView);
    localStorage.setItem("radulf.repo", repo);
    const query = new URLSearchParams();
    if (repo) query.set("repo", repo);
    if (nextView !== "overview") query.set("view", nextView);
    const href = query.size ? `/?${query}` : "/";
    window.history.pushState({}, "", href);
  }, []);

  const scoped = useMemo(
    () => (repoFilter ? cards.filter((card) => card.repoId === repoFilter) : cards),
    [cards, repoFilter]
  );
  const needs = useMemo(
    () => scoped.filter((card) => ["review", "plan_review", "needs_attention"].includes(card.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    [scoped]
  );
  const active = useMemo(
    () => scoped.filter((card) => activeStatuses.includes(card.status)).sort((a, b) => {
      const rank = (status: CardStatus) => status === "looping" ? 0 : status === "planning" ? 1 : 2;
      return rank(a.status) - rank(b.status) || a.position - b.position;
    }),
    [scoped]
  );
  const queue = useMemo(
    () => scoped.filter((card) => card.status === "todo").sort((a, b) => a.position - b.position),
    [scoped]
  );
  const backlog = useMemo(
    () => scoped.filter((card) => card.status === "backlog").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [scoped]
  );
  const done = useMemo(
    () => scoped.filter((card) => card.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [scoped]
  );
  const runningImprovementRuns = useMemo(
    () => improvementRuns.filter((r) => r.status === "running" && (!repoFilter || r.repoId === repoFilter)),
    [improvementRuns, repoFilter]
  );
  const counts: Record<View, number> = {
    overview: scoped.length,
    needs: needs.length,
    active: active.length + runningImprovementRuns.length,
    queue: queue.length,
    backlog: backlog.length,
    done: done.length,
  };

  async function runAction(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function start(card: BoardCard) {
    await runAction(() => api(`/api/cards/${card.id}/move`, { json: { to: "in_progress" } }));
  }

  async function addToQueue(card: BoardCard) {
    await runAction(() => api(`/api/cards/${card.id}/move`, { json: { to: "todo" } }));
  }

  async function reorder(card: BoardCard, direction: -1 | 1) {
    const index = queue.findIndex((item) => item.id === card.id);
    const target = index + direction;
    if (target < 0 || target >= queue.length) return;
    const before = direction < 0 ? queue[target - 1]?.position ?? 0 : queue[target].position;
    const after = direction < 0 ? queue[target].position : queue[target + 1]?.position ?? queue[target].position + 2;
    const position = (before + after) / 2;
    setCards((current) => current.map((item) => item.id === card.id ? { ...item, position } : item));
    setNotice(`${card.title} moved to position ${target + 1} of ${queue.length}.`);
    try {
      await api(`/api/cards/${card.id}/move`, { json: { to: "todo", position } });
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      refetch();
    }
  }

  async function toggleAutoMode() {
    const previous = autoMode;
    setAutoMode(!previous);
    try {
      await api("/api/settings", { method: "PATCH", json: { autoMode: !previous } });
    } catch (e) {
      setAutoMode(previous);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Unlike Auto Mode, this one hands merge authority to the evaluator for
  // every card that reaches a verdict, so turning it ON asks first. Turning it
  // off is always safe and never prompts.
  async function toggleAutoApprove() {
    const previous = autoApprove;
    if (!previous && !confirm("Turn on auto-approve?\n\nAn evaluator \u201Capprove\u201D will merge straight to the base branch with no human review. Integrity and merge-conflict checks still run, and a card that hits the evaluator's revision limit is still escalated to you.")) return;
    setAutoApprove(!previous);
    try {
      await api("/api/settings", { method: "PATCH", json: { autoApprove: !previous } });
    } catch (e) {
      setAutoApprove(previous);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function stopImprovementRun(run: ImprovementRun) {
    if (!confirm(`Stop the improvement run on “${run.featureBranch}”? The current task finishes, then the run ends.`)) return;
    await runAction(() => api(`/api/improvement-runs/${run.id}/stop`, { method: "POST" }));
  }

  async function restartServer() {
    const inProgress = cards.filter((card) => activeStatuses.includes(card.status)).length;
    if (!confirm(`Restart the server?${inProgress ? ` ${inProgress} active task${inProgress === 1 ? "" : "s"} will return to the backlog.` : ""}`)) return;
    setRestarting(true);
    await api("/api/restart", { method: "POST" }).catch(() => {});
    const poll = setInterval(async () => {
      try {
        const health = await api<{ ok?: boolean; restartRequired?: boolean }>("/api/health");
        if (health.ok && !health.restartRequired) {
          clearInterval(poll);
          location.reload();
        }
      } catch {}
    }, 1000);
    setTimeout(() => { clearInterval(poll); setRestarting(false); setError("Server did not return after restart."); }, 60_000);
  }

  const showSection = (section: View) => view === "overview" || view === section;
  const filteredEmpty = !loading && scoped.length > 0 && counts[view] === 0;

  return (
    <AppShell onNewTask={() => setShowNew(true)}>
      <main className="mx-auto w-full max-w-[800px] px-4 pb-8 pt-5 sm:px-6 lg:pt-8" aria-labelledby="work-title">
        <header className="flex items-center gap-3">
          <div className="min-w-0 grow">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-foreground/35">Workspace</p>
            <h1 id="work-title" tabIndex={-1} className="mt-0.5 text-2xl font-semibold tracking-tight">Work</h1>
          </div>
          <label className="sr-only" htmlFor="repo-scope">Repository scope</label>
          <select
            id="repo-scope"
            value={repoFilter}
            onChange={(event) => updateScope(event.target.value, view)}
            className="max-w-44 rounded-lg border border-foreground/10 bg-foreground/[0.05] px-3 text-sm"
          >
            <option value="">All repos</option>
            {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
          </select>
          <DetailsMenu detailsClassName="relative" summaryClassName="grid size-11 cursor-pointer list-none place-items-center rounded-lg bg-foreground/[0.06] text-xl text-foreground/70" menuClassName="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-foreground/10 bg-surface p-1.5 shadow-2xl" ariaLabel="Work actions" summary="•••">
              <button type="button" onClick={toggleAutoMode} className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left text-sm hover:bg-foreground/[0.06]">
                Auto Mode <span className={autoMode ? "text-green-300" : "text-foreground/40"}>{autoMode ? "On" : "Off"}</span>
              </button>
              <button type="button" onClick={toggleAutoApprove} className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left text-sm hover:bg-foreground/[0.06]">
                Auto-approve <span className={autoApprove ? "text-amber-300" : "text-foreground/40"}>{autoApprove ? "On" : "Off"}</span>
              </button>
              <button type="button" onClick={() => setShowImprovementRun(true)} disabled={repos.length === 0} className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-foreground/[0.06] disabled:opacity-40">
                Start improvement run
              </button>
          </DetailsMenu>
          <button type="button" onClick={() => setShowNew(true)} className="hidden min-h-11 rounded-lg bg-amber-600 px-4 text-sm font-semibold text-on-accent hover:bg-amber-500 lg:block">＋ New task</button>
        </header>

        <div className="mt-4 flex items-center gap-2 rounded-lg border border-foreground/[0.07] bg-foreground/[0.025] px-3 py-2 text-xs text-foreground/55">
          <span className={`size-2 shrink-0 rounded-full ${autoMode ? "bg-green-400" : "bg-slate-500"}`} aria-hidden="true" />
          <span>Auto Mode {autoMode ? "is on · Todo tasks run automatically" : "is off"}</span>
          {autoApprove && <span className="text-amber-300">· Auto-approve is on · approved work merges without review</span>}
          {!streamConnected && <span className="ml-auto text-amber-300">Offline · updates will resume</span>}
        </div>

        {(restartRequired || restarting) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            <span>{restarting ? "Restarting server…" : "A server restart is needed to apply database changes."}</span>
            {!restarting && <button type="button" onClick={restartServer} className="ml-auto rounded-md bg-amber-600 px-3 text-sm font-medium text-on-accent">Restart</button>}
          </div>
        )}

        {improvementAlert && (
          <div role="status" className={`mt-3 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm ${improvementAlert.status === "failed" ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-green-500/30 bg-green-500/10 text-green-200"}`}>
            <span>
              Improvement run {improvementAlert.status === "failed" ? "failed" : improvementAlert.status === "stopped" ? "stopped" : "finished"} on <code className="text-xs">{improvementAlert.featureBranch}</code> · {improvementAlert.tasksSucceeded} task{improvementAlert.tasksSucceeded === 1 ? "" : "s"} landed.
            </span>
            <button type="button" onClick={dismissImprovementAlert} className="ml-auto rounded-md bg-foreground/10 px-3 text-sm font-medium hover:bg-foreground/15">Dismiss</button>
          </div>
        )}

        <nav className="-mx-4 mt-5 overflow-x-auto px-4 sm:-mx-6 sm:px-6" aria-label="Work views">
          <div className="flex w-max min-w-full gap-2 pb-2">
            {views.map((item) => (
              <button
                type="button"
                key={item.key}
                onClick={() => updateScope(repoFilter, item.key)}
                aria-current={view === item.key ? "page" : undefined}
                className={`min-h-11 whitespace-nowrap rounded-full border px-3.5 text-sm ${view === item.key ? "border-amber-500/60 bg-amber-500/12 text-amber-200" : "border-foreground/10 bg-foreground/[0.03] text-foreground/55"}`}
              >
                {item.label} <span className="ml-1 tabular-nums text-foreground/40">{counts[item.key]}</span>
              </button>
            ))}
          </div>
        </nav>

        <div aria-live="polite" className="sr-only">{notice}</div>
        {error && <div role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}

        {loading ? <WorkSkeleton /> : cards.length === 0 ? (
          <Onboarding repos={repos} onNew={() => setShowNew(true)} />
        ) : filteredEmpty ? (
          <div className="mt-8 rounded-xl border border-foreground/10 bg-foreground/[0.025] p-6 text-center">
            <h2 className="font-medium">No tasks in this view</h2>
            <p className="mt-1 text-sm text-foreground/50">Try another repository or return to the full feed.</p>
            <button type="button" onClick={() => updateScope("", "overview")} className="mt-4 rounded-lg bg-foreground/10 px-4 text-sm">Clear filters</button>
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-7">
            {showSection("needs") && needs.length > 0 && (
              <WorkSection title="Needs you" count={needs.length} tone="text-violet-300">
                {needs.map((card) => <TaskRow key={card.id} card={card} repos={repos} onStart={start} onQueue={addToQueue} onAction={runAction} />)}
              </WorkSection>
            )}
            {showSection("active") && (active.length > 0 || runningImprovementRuns.length > 0) && (
              <WorkSection title="Active now" count={active.length + runningImprovementRuns.length} tone="text-amber-300">
                {runningImprovementRuns.map((r) => <ImprovementRunRow key={r.id} run={r} repos={repos} cards={cards} onStop={stopImprovementRun} />)}
                {active.map((card) => <TaskRow key={card.id} card={card} repos={repos} onStart={start} onQueue={addToQueue} onAction={runAction} />)}
              </WorkSection>
            )}
            {showSection("queue") && queue.length > 0 && (
              <WorkSection title="Up next" count={queue.length} tone="text-slate-300">
                {queue.map((card, index) => (
                  <TaskRow
                    key={card.id}
                    card={card}
                    repos={repos}
                    position={index + 1}
                    onStart={start}
                    onQueue={addToQueue}
                    onAction={runAction}
                    onMove={(direction) => reorder(card, direction)}
                    canMoveUp={index > 0}
                    canMoveDown={index < queue.length - 1}
                  />
                ))}
              </WorkSection>
            )}
            {showSection("backlog") && backlog.length > 0 && (
              <WorkSection title="Backlog" count={backlog.length} tone="text-foreground/50">
                {backlog.map((card) => <TaskRow key={card.id} card={card} repos={repos} onStart={start} onQueue={addToQueue} onAction={runAction} />)}
              </WorkSection>
            )}
            {showSection("done") && done.length > 0 && (
              view === "overview" ? (
                <details open={needs.length + active.length + queue.length + backlog.length === 0} className="group">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold uppercase tracking-[0.12em] text-green-300/80">
                    Recently completed <span className="text-foreground/35">{Math.min(5, done.length)}</span><span className="ml-auto normal-case tracking-normal text-foreground/40 group-open:hidden">Show</span>
                  </summary>
                  <div className="divide-y divide-white/[0.07] border-y border-foreground/[0.08]">{done.slice(0, 5).map((card) => <TaskRow key={card.id} card={card} repos={repos} onStart={start} onQueue={addToQueue} onAction={runAction} />)}</div>
                  {done.length > 5 && <button type="button" onClick={() => updateScope(repoFilter, "done")} className="mt-2 min-h-11 text-sm text-foreground/55 underline">View all completed tasks</button>}
                </details>
              ) : (
                <WorkSection title="Completed" count={done.length} tone="text-green-300">
                  {done.map((card) => <TaskRow key={card.id} card={card} repos={repos} onStart={start} onQueue={addToQueue} onAction={runAction} />)}
                </WorkSection>
              )
            )}
          </div>
        )}
      </main>

      {showNew && <NewTaskDialog repos={repos} defaultRepoId={repoFilter} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); refetch(); }} />}
      {showImprovementRun && <ImprovementRunDialog repos={repos} defaultRepoId={repoFilter} onClose={() => setShowImprovementRun(false)} onCreated={() => { setShowImprovementRun(false); refetch(); }} />}
    </AppShell>
  );
}

function WorkSection({ title, count, tone, children }: { title: string; count: number; tone: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`section-${title.replaceAll(" ", "-").toLowerCase()}`}>
      <h2 id={`section-${title.replaceAll(" ", "-").toLowerCase()}`} className={`mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] ${tone}`}>
        {title}<span className="text-foreground/35">{count}</span>
      </h2>
      <div className="divide-y divide-white/[0.07] border-y border-foreground/[0.08]">{children}</div>
    </section>
  );
}

function formatCountdown(deadlineAt: string, nowMs: number): string {
  const remainingMs = Date.parse(deadlineAt) - nowMs;
  if (remainingMs <= 0) return "Finishing up…";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m left`;
  return `${minutes}:${String(seconds).padStart(2, "0")} left`;
}

function ImprovementRunRow({ run, repos, cards, onStop }: { run: ImprovementRun; repos: Repo[]; cards: BoardCard[]; onStop: (run: ImprovementRun) => void }) {
  const nowMs = useNow(true, 1000);
  const repo = repos.find((r) => r.id === run.repoId);
  const currentCard = run.currentCardId ? cards.find((c) => c.id === run.currentCardId) : undefined;
  return (
    <article className="group flex min-w-0 cursor-default gap-3 py-3.5">
      <span className="mt-1 flex size-5 shrink-0 items-center justify-center text-sm font-bold text-amber-300" aria-hidden="true">◐</span>
      <div className="min-w-0 grow">
        <div className="flex min-w-0 items-start gap-2">
          <span className="min-w-0 grow text-[0.95rem] font-medium leading-5 text-foreground/90">Improvement run <code className="text-xs text-foreground/60">{run.featureBranch}</code></span>
          <span className="shrink-0 text-xs tabular-nums text-amber-300">{formatCountdown(run.deadlineAt, nowMs)}</span>
          <button type="button" onClick={() => onStop(run)} className="min-h-11 shrink-0 rounded-lg bg-foreground/10 px-3 text-sm font-semibold text-foreground/80 hover:bg-foreground/15">Stop</button>
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-foreground/48">
          <span className="text-foreground/65">{repo?.name ?? run.repoId}</span> · {run.tasksSucceeded} task{run.tasksSucceeded === 1 ? "" : "s"} landed · {currentCard ? `Current: ${currentCard.title}` : "Proposing the next improvement…"}
        </p>
      </div>
    </article>
  );
}

function TaskRow({ card, position, repos, onStart, onQueue, onAction, onMove, canMoveUp, canMoveDown }: {
  card: BoardCard;
  position?: number;
  repos: Repo[];
  onStart: (card: BoardCard) => Promise<void>;
  onQueue: (card: BoardCard) => Promise<void>;
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
  onMove?: (direction: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}) {
  const state = statusDetails(card);
  const repo = repos.find((r) => r.id === card.repoId);
  const branchLabel = card.baseBranch ?? repo?.defaultBranch ?? null;
  const href = card.status === "review" ? `/review/${card.id}` : `/card/${card.id}`;
  const pullBack = () => {
    const active = ["planning", "looping", "evaluating"].includes(card.status);
    if (active && !confirm(`Cancel the active run for “${card.title}” and return it to the backlog?`)) return;
    void onAction(() => api(`/api/cards/${card.id}/move`, { json: { to: "backlog" } }));
  };
  const remove = () => {
    if (!confirm(`Delete “${card.title}” and all its history?`)) return;
    void onAction(() => api(`/api/cards/${card.id}`, { method: "DELETE" }));
  };

  return (
    <article className="group relative flex min-w-0 gap-3 py-3.5 hover:bg-foreground/[0.025]">
      {/* Stretched-link overlay: covers the whole row so a click anywhere navigates, while
          staying out of the tab order (aria-hidden + tabIndex=-1) since the title Link below
          is the row's one real, screen-reader-visible link. Nested controls sit above it via
          z-10 on the content wrapper, so they receive their own clicks natively — no
          closest()/stopPropagation delegation hack needed. */}
      <Link href={href} aria-hidden="true" tabIndex={-1} className="absolute inset-0" />
      {position !== undefined && <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.04] text-xs tabular-nums text-foreground/40">{position}</span>}
      <span className={`mt-1 flex size-5 shrink-0 items-center justify-center text-sm font-bold ${state.tone}`} aria-hidden="true">{state.mark}</span>
      <div className="relative z-10 min-w-0 grow">
        <div className="flex min-w-0 items-start gap-2">
          <Link href={href} className="min-w-0 grow text-[0.95rem] font-medium leading-5 text-foreground/90 hover:underline">
            {card.source === "agent" && <span className="mr-1 text-xs text-amber-300" title="Agent-proposed task">AI</span>}{card.title}
          </Link>
          {card.status === "backlog" && <button type="button" onClick={() => void onQueue(card)} className="min-h-11 shrink-0 rounded-lg bg-foreground/10 px-3 text-sm font-semibold text-foreground/80 hover:bg-foreground/15">Add to queue</button>}
          {card.status === "todo" && <button type="button" onClick={() => void onStart(card)} className="min-h-11 shrink-0 rounded-lg bg-amber-600 px-3 text-sm font-semibold text-on-accent hover:bg-amber-500">Start now</button>}
          {card.status === "review" && <Link href={`/review/${card.id}`} className="touch-target flex shrink-0 items-center rounded-lg bg-violet-500/15 px-3 text-sm font-medium text-violet-200">Review</Link>}
          {card.status === "plan_review" && <Link href={`/card/${card.id}`} className="touch-target flex shrink-0 items-center rounded-lg bg-cyan-500/15 px-3 text-sm font-medium text-cyan-200">Approve plan</Link>}
          {card.status === "needs_attention" && <Link href={`/card/${card.id}`} className="touch-target flex shrink-0 items-center rounded-lg bg-red-500/15 px-3 text-sm font-medium text-red-200">Resolve</Link>}
          {card.status === "looping" && <button type="button" onClick={() => { if (!confirm(`Pause “${card.title}” after the current iteration finishes?`)) return; void onAction(() => api(`/api/cards/${card.id}/pause`, { json: {} })); }} className="touch-target flex shrink-0 items-center rounded-lg bg-foreground/[0.06] px-3 text-sm text-foreground/70 hover:bg-foreground/[0.10]">⏸ Pause</button>}
          {card.status === "paused" && <button type="button" onClick={() => { void onAction(() => api(`/api/cards/${card.id}/resume`, { json: {} })); }} className="touch-target flex shrink-0 items-center rounded-lg bg-sky-500/15 px-3 text-sm font-medium text-sky-200 hover:bg-sky-500/25">▶ Continue</button>}
          {activeStatuses.includes(card.status) && <Link href={`/card/${card.id}?tab=activity`} className="touch-target hidden shrink-0 items-center rounded-lg bg-foreground/[0.06] px-3 text-sm text-foreground/70 sm:flex">View activity</Link>}
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-foreground/48">
          <span className="text-foreground/65">{card.repoName}{branchLabel ? ` → ${branchLabel}` : ""}</span> · <span className={state.tone}>{state.label}</span> · {position ? `Queue position ${position}` : state.detail}
        </p>
        {card.status === "looping" && <p className="mt-0.5 truncate text-xs text-foreground/40">{card.latestRun?.currentTask ? `Current task: ${card.latestRun.currentTask}` : `Latest activity: ${card.latestRun?.exitReason || "Ralph is working through the current iteration"}`}</p>}
        {card.status === "paused" && <p className="mt-0.5 truncate text-xs text-foreground/40">Paused after iteration {card.latestRun?.iterationsDone ?? 0} · {card.latestRun?.exitReason || "Waiting to resume"}</p>}
        {card.status === "needs_attention" && state.detail.length > 70 && <p className="mt-0.5 line-clamp-2 text-xs text-red-200/60">{state.detail}</p>}
        {(onMove || card.status !== "todo") && (
          <div className="mt-1 flex min-h-11 items-center gap-1">
            {onMove && <>
              <button type="button" disabled={!canMoveUp} onClick={() => onMove(-1)} aria-label={`Move ${card.title} up`} className="size-11 rounded-md text-lg text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-20">↑</button>
              <button type="button" disabled={!canMoveDown} onClick={() => onMove(1)} aria-label={`Move ${card.title} down`} className="size-11 rounded-md text-lg text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-20">↓</button>
            </>}
            <DetailsMenu detailsClassName="relative ml-auto" summaryClassName="grid size-11 cursor-pointer list-none place-items-center rounded-md text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground" menuClassName="absolute bottom-10 right-0 z-20 w-52 rounded-lg border border-foreground/10 bg-surface p-1 shadow-xl" ariaLabel={`More actions for ${card.title}`} summary="•••">
                <Link href={`/card/${card.id}`} className="flex min-h-11 items-center rounded-md px-3 text-sm hover:bg-foreground/[0.06]">Open task details</Link>
                {["todo", "planning", "ready", "looping", "evaluating", "paused", "review", "plan_review", "needs_attention"].includes(card.status) && <button type="button" onClick={pullBack} className="w-full rounded-md px-3 text-left text-sm hover:bg-foreground/[0.06]">Move to backlog</button>}
                {["backlog", "todo", "done"].includes(card.status) && <button type="button" onClick={remove} className="w-full rounded-md px-3 text-left text-sm text-red-300 hover:bg-red-500/10">Delete task</button>}
            </DetailsMenu>
          </div>
        )}
      </div>
    </article>
  );
}

function WorkSkeleton() {
  return <div aria-label="Loading work" className="mt-8 animate-pulse space-y-6"><div className="h-4 w-28 rounded bg-foreground/10"/><div className="h-20 rounded bg-foreground/[0.04]"/><div className="h-20 rounded bg-foreground/[0.04]"/><span className="sr-only">Loading tasks…</span></div>;
}

function Onboarding({ repos, onNew }: { repos: Repo[]; onNew: () => void }) {
  return (
    <section className="mt-8 rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-6">
      <p className="text-xs font-medium uppercase tracking-widest text-amber-300">Get started</p>
      <h2 className="mt-2 text-xl font-semibold">Give Ralph its first task</h2>
      <ol className="mt-5 space-y-4 text-sm text-foreground/65">
        <li className="flex gap-3"><span className="text-amber-300">1</span>{repos.length ? "Repository registered." : <span>Register a repository in <Link href="/settings" className="text-amber-300 underline">Settings</Link>.</span>}</li>
        <li className="flex gap-3"><span className="text-amber-300">2</span>Create a task with a clear definition of done.</li>
        <li className="flex gap-3"><span className="text-amber-300">3</span>Add it to Todo when it is ready. Auto Mode will pick it up.</li>
      </ol>
      <button type="button" onClick={onNew} disabled={!repos.length} className="mt-6 rounded-lg bg-amber-600 px-4 text-sm font-semibold text-on-accent disabled:opacity-40">Create task</button>
    </section>
  );
}
