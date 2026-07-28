"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CreateImprovementRunRequest } from "@/shared/improvementRunRequests";
import { api, type Repo } from "./api";
import { ModelSelect } from "./newTaskDialog";

type BudgetUnit = "minutes" | "hours";

export function ImprovementRunDialog({ repos, onClose, onCreated, defaultRepoId }: { repos: Repo[]; onClose: () => void; onCreated: () => void; defaultRepoId?: string }) {
  const [repoId, setRepoId] = useState(defaultRepoId && repos.some((r) => r.id === defaultRepoId) ? defaultRepoId : repos[0]?.id ?? "");
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  const [focusPrompt, setFocusPrompt] = useState("");
  const [budgetAmount, setBudgetAmount] = useState("30");
  const [budgetUnit, setBudgetUnit] = useState<BudgetUnit>("minutes");
  const [plannerModel, setPlannerModel] = useState("");
  const [loopModel, setLoopModel] = useState("");
  const [evaluatorModel, setEvaluatorModel] = useState("");
  const [plannerProvider, setPlannerProvider] = useState("");
  const [loopProvider, setLoopProvider] = useState("");
  const [evaluatorProvider, setEvaluatorProvider] = useState("");
  const [maxIterations, setMaxIterations] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("");
  const [models, setModels] = useState<{ planner: { value: string; displayName: string }[]; loop: { value: string; displayName: string }[]; evaluator: { value: string; displayName: string }[] }>({ planner: [], loop: [], evaluator: [] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const dirty = Boolean(focusPrompt || plannerModel || loopModel || evaluatorModel || maxIterations || timeoutMinutes || budgetAmount !== "30" || budgetUnit !== "minutes");

  const requestClose = useCallback(() => {
    if (dirty && !confirm("Discard this improvement run setup?")) return;
    onClose();
  }, [dirty, onClose]);
  const requestCloseRef = useRef(requestClose);
  useEffect(() => { requestCloseRef.current = requestClose; });

  useEffect(() => {
    invoker.current = document.activeElement as HTMLElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary') ?? []);
    focusable()[0]?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); requestCloseRef.current(); }
      if (event.key === "Tab") {
        const items = focusable();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); invoker.current?.focus(); };
  }, []);

  useEffect(() => {
    api<{ plannerProvider: string; loopProvider: string; evaluatorProvider: string }>("/api/settings")
      .then(async (settings) => {
        setPlannerProvider(settings.plannerProvider);
        setLoopProvider(settings.loopProvider);
        setEvaluatorProvider(settings.evaluatorProvider);
        const load = (provider: string) => api<{ models: { value: string; displayName: string }[] }>(`/api/providers/${provider}/models`).catch(() => ({ models: [] }));
        const [planner, loop, evaluator] = await Promise.all([load(settings.plannerProvider), load(settings.loopProvider), load(settings.evaluatorProvider)]);
        setModels({ planner: planner.models, loop: loop.models, evaluator: evaluator.models });
      }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!repoId) return;
    const applyBranches = (list: string[]) => {
      setBranches(list);
      const repo = repos.find((r) => r.id === repoId);
      const fallback = repo && list.includes(repo.defaultBranch) ? repo.defaultBranch : list[0] ?? "";
      setBaseBranch((current) => (current && list.includes(current)) ? current : fallback);
    };
    fetch(`/api/repos/${repoId}/branches`)
      .then(async (res) => {
        if (!res.ok) { applyBranches([]); return; }
        const data = await res.json();
        applyBranches(Array.isArray(data) ? (data as string[]) : []);
      })
      .catch(() => { applyBranches([]); });
  }, [repoId, repos]);

  async function create() {
    setBusy(true); setError("");
    try {
      const amount = Number(budgetAmount);
      const budgetMinutes = budgetUnit === "hours" ? amount * 60 : amount;
      const request: CreateImprovementRunRequest = {
        repoId,
        baseBranch,
        budgetMinutes,
        focusPrompt,
        plannerModel,
        loopModel,
        evaluatorModel,
        maxIterations,
        timeoutMinutes,
      };
      await api("/api/improvement-runs", { json: request });
      onCreated();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  const budgetValid = Number.isFinite(Number(budgetAmount)) && Number(budgetAmount) > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="improvement-run-title" className="flex max-h-[min(92dvh,800px)] w-full flex-col rounded-t-2xl border border-foreground/10 bg-surface shadow-2xl sm:max-w-xl sm:rounded-2xl">
        <header className="flex shrink-0 items-center border-b border-foreground/10 px-4 py-3">
          <h2 id="improvement-run-title" className="grow text-lg font-semibold">Start improvement run</h2>
          <button type="button" onClick={requestClose} aria-label="Close improvement run setup" className="grid size-11 place-items-center rounded-lg text-xl text-foreground/55 hover:bg-foreground/[0.06]">×</button>
        </header>
        <div className="min-h-0 grow space-y-4 overflow-y-auto p-4 sm:p-5">
          {repos.length === 0 ? <p className="text-sm text-foreground/60">Register a repository in <Link href="/settings" className="text-amber-300 underline">Settings</Link> first.</p> : <>
            <p className="text-sm text-foreground/60">Ralph will repeatedly propose one improvement, drive it through the pipeline with auto-approve, and accumulate every approved change on a new feature branch — until the time budget runs out or three tasks fail in a row.</p>
            <label className="block text-sm text-foreground/70">Repository<select value={repoId} onChange={(e) => { setRepoId(e.target.value); setBranches([]); }} className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3">{repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
            {repoId && <label className="block text-sm text-foreground/70">Base branch<select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3">{branches.length === 0 && <option value="">Loading…</option>}{branches.map((b) => <option key={b} value={b}>{b}</option>)}</select></label>}
            <p className="text-xs text-foreground/40">A new branch is cut off the base branch (<code>ralph/improve-&lt;timestamp&gt;</code>) — every task in this run merges into it, never into the base branch directly.</p>
            <label className="block text-sm text-foreground/70">Focus (optional)<textarea value={focusPrompt} onChange={(e) => setFocusPrompt(e.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm" placeholder="Steer what Ralph should focus on, e.g. 'improve test coverage' or 'clean up the API layer'. Leave blank to let Ralph decide." /></label>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <label className="text-sm text-foreground/70">Time budget<input type="number" min="1" value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3" /></label>
              <label className="text-sm text-foreground/70">Unit<select value={budgetUnit} onChange={(e) => setBudgetUnit(e.target.value as BudgetUnit)} className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3"><option value="minutes">Minutes</option><option value="hours">Hours</option></select></label>
            </div>
            <details className="rounded-lg border border-foreground/10 bg-foreground/[0.02]">
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">Advanced</summary>
              <div className="space-y-3 border-t border-foreground/10 p-3">
                <ModelSelect label="Planner model" providerId={plannerProvider} value={plannerModel} setValue={setPlannerModel} models={models.planner} inputId="improve-planner-model-input" datalistId="improve-planner-models" />
                <ModelSelect label="Loop model" providerId={loopProvider} value={loopModel} setValue={setLoopModel} models={models.loop} inputId="improve-loop-model-input" datalistId="improve-loop-models" />
                <ModelSelect label="Evaluator model" providerId={evaluatorProvider} value={evaluatorModel} setValue={setEvaluatorModel} models={models.evaluator} inputId="improve-evaluator-model-input" datalistId="improve-evaluator-models" />
                <div className="grid grid-cols-2 gap-3"><label className="text-sm text-foreground/70">Per-task iteration cap<input type="number" min="1" value={maxIterations} onChange={(e) => setMaxIterations(e.target.value)} placeholder="Default" className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3" /></label><label className="text-sm text-foreground/70">Per-task timeout (min)<input type="number" min="1" value={timeoutMinutes} onChange={(e) => setTimeoutMinutes(e.target.value)} placeholder="Default" className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3" /></label></div>
                <p className="text-xs text-foreground/40">Each task&rsquo;s timeout is additionally capped at whatever time budget remains in the run.</p>
              </div>
            </details>
            <p className="text-xs text-amber-400/80">Every task in this run auto-approves on evaluator pass — merges straight into the feature branch with no human review. Integrity and merge-conflict checks still run.</p>
          </>}
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-foreground/10 bg-surface p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] sm:p-4">
          <button type="button" onClick={requestClose} className="rounded-lg px-4 text-sm text-foreground/60">Cancel</button>
          <button type="button" onClick={create} disabled={busy || !repoId || !baseBranch || !budgetValid} className="rounded-lg bg-amber-600 px-5 text-sm font-semibold text-on-accent disabled:opacity-40">{busy ? "Starting…" : "Start run"}</button>
        </footer>
      </div>
    </div>
  );
}
