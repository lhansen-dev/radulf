"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import type { CreateImprovementRunRequest } from "@/shared/improvementRunRequests";
import { api, type Repo } from "./api";
import { DialogShell, EMPTY_ROLE_MODELS, RepoSelect, RoleModelSelects, RunLimitInputs, dialogInputCls, useBranches, useRoleModelOptions } from "./taskDialog";
import { errorMessage } from "@/shared/errorMessage";

type BudgetUnit = "minutes" | "hours";

export function ImprovementRunDialog({ repos, onClose, onCreated, defaultRepoId }: { repos: Repo[]; onClose: () => void; onCreated: () => void; defaultRepoId?: string }) {
  const [repoId, setRepoId] = useState(defaultRepoId && repos.some((r) => r.id === defaultRepoId) ? defaultRepoId : repos[0]?.id ?? "");
  const [baseBranch, setBaseBranch] = useState("");
  const [branches, setBranches] = useBranches(repoId, (list) => {
    const repo = repos.find((r) => r.id === repoId);
    const fallback = repo && list.includes(repo.defaultBranch) ? repo.defaultBranch : list[0] ?? "";
    setBaseBranch((current) => (current && list.includes(current)) ? current : fallback);
  });
  const [focusPrompt, setFocusPrompt] = useState("");
  const [budgetAmount, setBudgetAmount] = useState("30");
  const [budgetUnit, setBudgetUnit] = useState<BudgetUnit>("minutes");
  const [roleModels, setRoleModels] = useState(EMPTY_ROLE_MODELS);
  const { providers, models } = useRoleModelOptions();
  const [maxIterations, setMaxIterations] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = Boolean(focusPrompt || roleModels.planner || roleModels.loop || roleModels.evaluator || maxIterations || timeoutMinutes || budgetAmount !== "30" || budgetUnit !== "minutes");

  const requestClose = useCallback(() => {
    if (dirty && !confirm("Discard this improvement run setup?")) return;
    onClose();
  }, [dirty, onClose]);
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
        plannerModel: roleModels.planner,
        loopModel: roleModels.loop,
        evaluatorModel: roleModels.evaluator,
        maxIterations,
        timeoutMinutes,
      };
      await api("/api/improvement-runs", { json: request });
      onCreated();
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }

  const budgetValid = Number.isFinite(Number(budgetAmount)) && Number(budgetAmount) > 0;

  return (
    <DialogShell
      titleId="improvement-run-title"
      title="Start improvement run"
      closeLabel="Close improvement run setup"
      onRequestClose={requestClose}
      footer={<>
        <button type="button" onClick={requestClose} className="rounded-lg px-4 text-sm text-foreground/60">Cancel</button>
        <button type="button" onClick={create} disabled={busy || !repoId || !baseBranch || !budgetValid} className="rounded-lg bg-amber-600 px-5 text-sm font-semibold text-on-accent disabled:opacity-40">{busy ? "Starting…" : "Start run"}</button>
      </>}
    >
          {repos.length === 0 ? <p className="text-sm text-foreground/60">Register a repository in <Link href="/settings" className="text-amber-300 underline">Settings</Link> first.</p> : <>
            <p className="text-sm text-foreground/60">Ralph will repeatedly propose one improvement, drive it through the pipeline with auto-approve, and accumulate every approved change on a new feature branch — until the time budget runs out or three tasks fail in a row.</p>
            <RepoSelect repos={repos} value={repoId} onChange={(value) => { setRepoId(value); setBranches([]); }} />
            {repoId && <label className="block text-sm text-foreground/70">Base branch<select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className={dialogInputCls}>{branches.length === 0 && <option value="">Loading…</option>}{branches.map((b) => <option key={b} value={b}>{b}</option>)}</select></label>}
            <p className="text-xs text-foreground/40">A new branch is cut off the base branch (<code>ralph/improve-&lt;timestamp&gt;</code>) — every task in this run merges into it, never into the base branch directly.</p>
            <label className="block text-sm text-foreground/70">Focus (optional)<textarea value={focusPrompt} onChange={(e) => setFocusPrompt(e.target.value)} rows={4} className={`${dialogInputCls} py-2 text-sm`} placeholder="Steer what Ralph should focus on, e.g. 'improve test coverage' or 'clean up the API layer'. Leave blank to let Ralph decide." /></label>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <label className="text-sm text-foreground/70">Time budget<input type="number" min="1" value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} className={dialogInputCls} /></label>
              <label className="text-sm text-foreground/70">Unit<select value={budgetUnit} onChange={(e) => setBudgetUnit(e.target.value as BudgetUnit)} className={dialogInputCls}><option value="minutes">Minutes</option><option value="hours">Hours</option></select></label>
            </div>
            <details className="rounded-lg border border-foreground/10 bg-foreground/[0.02]">
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">Advanced</summary>
              <div className="space-y-3 border-t border-foreground/10 p-3">
                <RoleModelSelects providers={providers} models={models} values={roleModels} onChange={setRoleModels} idPrefix="improve-" />
                <RunLimitInputs perTask maxIterations={maxIterations} setMaxIterations={setMaxIterations} timeoutMinutes={timeoutMinutes} setTimeoutMinutes={setTimeoutMinutes} />
                <p className="text-xs text-foreground/40">Each task&rsquo;s timeout is additionally capped at whatever time budget remains in the run.</p>
              </div>
            </details>
            <p className="text-xs text-amber-400/80">Every task in this run auto-approves on evaluator pass — merges straight into the feature branch with no human review. Integrity and merge-conflict checks still run.</p>
          </>}
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </DialogShell>
  );
}
