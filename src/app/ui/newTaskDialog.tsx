"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CreateCardRequest } from "@/shared/cardRequests";
import { api, type Repo } from "./api";
import { DialogShell, EMPTY_ROLE_MODELS, RepoSelect, RoleModelSelects, RunLimitInputs, dialogInputCls, useBranches, useRoleModelOptions } from "./taskDialog";
import { FolderBrowser } from "./folderBrowser";
import { errorMessage } from "@/shared/errorMessage";

export function NewTaskDialog({ repos, onClose, onCreated, defaultRepoId }: { repos: Repo[]; onClose: () => void; onCreated: () => void; defaultRepoId?: string }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  // Seeded from the prop, then appended to when a repository is registered
  // from inside this dialog, so the new one is selectable without closing it.
  const [repoList, setRepoList] = useState<Repo[]>(repos);
  const [repoId, setRepoId] = useState(defaultRepoId && repos.some((r) => r.id === defaultRepoId) ? defaultRepoId : repos[0]?.id ?? "");
  const [addingRepo, setAddingRepo] = useState(repos.length === 0);

  function adoptRepo(created: Repo) {
    setRepoList((current) => [...current, created]);
    setRepoId(created.id);
    setBranches([]);
    setSelectedBranch("");
    setAddingRepo(false);
  }
  async function registerRepo(folder: string) {
    setError("");
    try {
      adoptRepo(await api<Repo>("/api/repos", {
        json: { name: folder.split("/").pop() || folder, path: folder },
      }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  // Errors propagate: the browser reports them through onError.
  async function createRepo(parentPath: string, name: string) {
    setError("");
    adoptRepo(await api<Repo>("/api/repos/init", { json: { parentPath, name } }));
  }
  async function cloneRepo(url: string) {
    setError("");
    adoptRepo(await api<Repo>("/api/repos/clone", { json: { url } }));
  }
  const [description, setDescription] = useState("");
  const [jiraRef, setJiraRef] = useState("");
  const [importing, setImporting] = useState(false);
  // Importing a file creates its cards directly rather than prefilling this
  // dialog: a file may hold many, and there is nothing to fill in for the
  // second one. Its cards land in Backlog, like anything created here.
  async function importFromFile(file: File) {
    if (!repoId || importing) return;
    setImporting(true); setError("");
    try {
      const payload = JSON.parse(await file.text()) as Record<string, unknown>;
      const result = await api<{ cardIds: string[]; notes: string[] }>("/api/cards/import", {
        json: { ...payload, repoId },
      });
      onCreated();
      if (result.notes.length > 0) {
        alert(`Imported ${result.cardIds.length} card(s).\n\n${result.notes.join("\n")}`);
      }
      onClose();
    } catch (e) {
      setError(e instanceof SyntaxError ? "that file is not JSON Radulf can read" : errorMessage(e));
    } finally {
      setImporting(false);
    }
  }
  // Prefills title and description from the issue; the user edits before creating.
  async function importFromJira() {
    const ref = jiraRef.trim();
    if (!ref || importing) return;
    setImporting(true); setError("");
    try {
      const draft = await api<{ title: string; description: string }>(`/api/jira/issue?ref=${encodeURIComponent(ref)}`);
      setTitle(draft.title);
      setDescription(draft.description);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setImporting(false);
    }
  }
  const [roleModels, setRoleModels] = useState(EMPTY_ROLE_MODELS);
  const { providers, models } = useRoleModelOptions();
  const [maxIterations, setMaxIterations] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("");
  const [reviewPlanBeforeImplementation, setReviewPlanBeforeImplementation] = useState(false);
  const [grillMe, setGrillMe] = useState(false);
  const [scopingAuthorsPlan, setScopingAuthorsPlan] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [openPr, setOpenPr] = useState(false);
  // Spec 15: PR delivery is only offerable when `gh` is installed and
  // authenticated AND the selected repo has an `origin`. Tagged with the repo
  // it describes, so a stale answer for the previously selected repo reads as
  // "unknown" rather than as permission to tick the box.
  const [prReady, setPrReady] = useState<{ repoId: string; ok: boolean; detail: string | null; hasRemote: boolean | null } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [branches, setBranches] = useBranches(repoId);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const prStatus = prReady && prReady.repoId === repoId ? prReady : null;
  const prDeliverable = Boolean(prStatus?.ok && prStatus.hasRemote);
  // Say which of the three preconditions is missing — install a tool, run a
  // login, and add a remote are three different next actions.
  const prBlockedReason = prStatus === null || prDeliverable
    ? null
    : prStatus.ok
      ? "This repo has no `origin` remote to open a pull request against."
      : prStatus.detail;
  const dirty = Boolean(title || description || jiraRef || roleModels.planner || roleModels.loop || roleModels.evaluator || maxIterations || timeoutMinutes || selectedBranch) || reviewPlanBeforeImplementation || grillMe || scopingAuthorsPlan || autoApprove || openPr;

  const requestClose = useCallback(() => {
    if (dirty && !confirm("Discard your unsaved task?")) return;
    onClose();
  }, [dirty, onClose]);
  useEffect(() => {
    if (!repoId) return;
    let live = true;
    api<{ ok: boolean; detail: string | null; hasRemote: boolean | null }>(`/api/github/status?repoId=${encodeURIComponent(repoId)}`)
      .then((status) => {
        if (!live) return;
        setPrReady({ repoId, ...status });
        // Never leave the box ticked for a target that cannot deliver.
        if (!status.ok || !status.hasRemote) setOpenPr(false);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [repoId]);

  // Spec 17: a rough ask is enough — "Create and scope" opens the card on
  // its scoping thread, where an assistant that reads the repo sharpens it.
  // Spec 24: "Create and break down" opens it asking that thread for the
  // pieces straight away.
  async function create(then?: "scope" | "breakdown") {
    setBusy(true); setError("");
    try {
      const request: CreateCardRequest = {
        repoId,
        title,
        description,
        plannerModel: roleModels.planner,
        loopModel: roleModels.loop,
        evaluatorModel: roleModels.evaluator,
        maxIterations,
        timeoutMinutes,
        reviewPlanBeforeImplementation,
        grillMe,
        scopingAuthorsPlan,
        autoApprove,
        openPr,
        baseBranch: selectedBranch || null,
      };
      const created = await api<{ id: string }>("/api/cards", { json: request });
      onCreated();
      if (then === "scope") router.push(`/card/${created.id}`);
      if (then === "breakdown") router.push(`/card/${created.id}?breakdown=propose`);
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }

  return (
    <DialogShell
      titleId="new-task-title"
      title="New task"
      closeLabel="Close new task"
      onRequestClose={requestClose}
      footer={<>
        <span className="mr-auto self-center text-xs text-foreground/45">New tasks go to Backlog</span>
        <button type="button" onClick={requestClose} className="rounded-lg px-4 text-sm text-foreground/60">Cancel</button>
        <button type="button" onClick={() => create("breakdown")} disabled={busy || !title.trim() || !repoId} className="rounded-lg bg-foreground/10 px-4 text-sm disabled:opacity-40">Create and break down</button>
        <button type="button" onClick={() => create("scope")} disabled={busy || !title.trim() || !repoId} className="rounded-lg bg-foreground/10 px-4 text-sm disabled:opacity-40">Create and scope</button>
        <button type="button" onClick={() => create()} disabled={busy || !title.trim() || !repoId} className="rounded-lg bg-amber-600 px-5 text-sm font-semibold text-on-accent disabled:opacity-40">{busy ? "Creating…" : "Create task"}</button>
      </>}
    >
          {repoList.length === 0 ? <div className="space-y-2"><p className="text-sm text-foreground/60">No repositories yet. Browse for one, or register it in <Link href="/settings" className="text-amber-300 underline">Settings</Link>.</p><FolderBrowser onPick={registerRepo} onCreate={createRepo} onClone={cloneRepo} onError={setError} /></div> : <>
            <div className="flex items-end gap-2">
              <label className="block grow text-sm text-foreground/70">Import from Jira<input value={jiraRef} onChange={(e) => setJiraRef(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void importFromJira(); } }} placeholder="Issue link or key, e.g. DEV-123 (optional)" className={dialogInputCls} /></label>
              <button type="button" onClick={() => void importFromJira()} disabled={importing || !jiraRef.trim()} className="rounded-lg bg-foreground/10 px-4 text-sm disabled:opacity-40">{importing ? "Importing…" : "Import"}</button>
            </div>
            <label className="block text-sm text-foreground/70">Import an exported file<input type="file" accept="application/json,.json" disabled={importing || !repoId} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void importFromFile(file); }} className={`${dialogInputCls} py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-foreground/10 file:px-2 file:py-1 file:text-sm file:text-foreground/80`} /></label>
            <p className="-mt-1 text-xs text-foreground/45">A card exported from this or another Radulf, with its scoping thread. Its cards go straight to Backlog for the repository selected below.</p>
            <label className="block text-sm text-foreground/70">Title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={dialogInputCls} required /></label>
            <RepoSelect repos={repoList} value={repoId} onChange={(value) => { if (value === "__add__") { setAddingRepo(true); return; } setRepoId(value); setBranches([]); setSelectedBranch(""); setShowNewBranch(false); setNewBranchName(""); }}><option value="__add__">Add a repository…</option></RepoSelect>
            {addingRepo && <FolderBrowser onPick={registerRepo} onCreate={createRepo} onClone={cloneRepo} onError={setError} />}
            {repoId && <label className="block text-sm text-foreground/70">Branch<select value={selectedBranch} onChange={(e) => { const v = e.target.value; if (v === "__new__") { setShowNewBranch(true); setSelectedBranch(""); } else { setShowNewBranch(false); setSelectedBranch(v); } }} className={dialogInputCls}><option value="">Default branch</option>{branches.map((b) => <option key={b} value={b}>{b}</option>)}<option value="__new__">Add new branch…</option></select></label>}
            {showNewBranch && <div className="flex gap-2"><input value={newBranchName} onChange={(e) => setNewBranchName(e.target.value)} placeholder="Branch name" className="grow rounded-lg border border-foreground/10 bg-foreground/5 px-3 text-sm" /><button type="button" onClick={async () => { const name = newBranchName.trim(); if (!name) return; try { const repo = repoList.find((r) => r.id === repoId); if (!repo) return; await api(`/api/repos/${repoId}/branches`, { json: { name, from: repo.defaultBranch } }); setBranches((prev) => prev.includes(name) ? prev : [...prev, name]); setSelectedBranch(name); setShowNewBranch(false); setNewBranchName(""); } catch (e) { setError(errorMessage(e)); }}} disabled={!newBranchName.trim()} className="rounded-lg bg-foreground/10 px-3 text-sm disabled:opacity-40">Add</button></div>}
            <label className="block text-sm text-foreground/70">Description and definition of done<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={7} className={`${dialogInputCls} py-2 text-sm`} placeholder="Describe the outcome, constraints, and how Ralph can verify the work — or start rough and use Create and scope." /></label>
            <details className="rounded-lg border border-foreground/10 bg-foreground/[0.02]">
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">Advanced</summary>
              <div className="space-y-3 border-t border-foreground/10 p-3">
                <RoleModelSelects providers={providers} models={models} values={roleModels} onChange={setRoleModels} />
                <RunLimitInputs maxIterations={maxIterations} setMaxIterations={setMaxIterations} timeoutMinutes={timeoutMinutes} setTimeoutMinutes={setTimeoutMinutes} />
                <label className="flex items-center gap-2 text-sm text-foreground/70"><input type="checkbox" checked={reviewPlanBeforeImplementation} onChange={(e) => setReviewPlanBeforeImplementation(e.target.checked)} className="size-4 accent-amber-600" />Review plan before implementation</label>
                <label className="flex items-center gap-2 text-sm text-foreground/70"><input type="checkbox" checked={grillMe} onChange={(e) => setGrillMe(e.target.checked)} className="size-4 accent-amber-600" />Grill me while scoping</label>
                {grillMe && <p className="text-xs text-foreground/55">The scoping session maps the card as a design tree and asks every question whose prerequisites are already settled in one numbered round, each with a recommendation, until nothing is left assumed. A longer conversation than the default few questions a turn, and worth it on a vague ask.</p>}
                <label className="flex items-center gap-2 text-sm text-foreground/70"><input type="checkbox" checked={scopingAuthorsPlan} onChange={(e) => setScopingAuthorsPlan(e.target.checked)} className="size-4 accent-amber-600" />Let scoping write the plan</label>
                {scopingAuthorsPlan && <p className="text-xs text-foreground/55">The scoping session can write PLAN.md, PROMPT.md and CRITERIA.md itself and the planning stage is skipped. Worth it when the planner is the weakest model in the pipeline. Tick <em>Review plan before implementation</em> too if you want to read the result first.</p>}
                <label className="flex items-center gap-2 text-sm text-foreground/70"><input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} className="size-4 accent-amber-600" />Auto-approve on evaluator pass (skip human review)</label>
                {autoApprove && <p className="text-xs text-amber-400/80">The evaluator&rsquo;s approval merges straight to the base branch with no human review. Integrity and merge-conflict checks still run. This card keeps this setting even when the workspace-wide toggle is off.</p>}
                <label className="flex items-center gap-2 text-sm text-foreground/70"><input type="checkbox" checked={openPr} disabled={!prDeliverable} onChange={(e) => setOpenPr(e.target.checked)} className="size-4 accent-amber-600 disabled:opacity-40" />Open a pull request instead of merging</label>
                {prBlockedReason && <p className="text-xs text-foreground/45">{prBlockedReason}</p>}
                {openPr && <p className="text-xs text-foreground/55">On approval the branch is pushed to <code>origin</code> and a pull request is opened against the base branch. Nothing is merged locally, and Radulf never merges the pull request.</p>}
              </div>
            </details>
          </>}
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </DialogShell>
  );
}
