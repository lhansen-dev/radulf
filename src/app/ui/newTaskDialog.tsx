"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { CreateCardRequest } from "@/shared/cardRequests";
import { api, type Repo } from "./api";
import { DeliveryOptions, DialogShell, DiscardPrompt, EMPTY_ROLE_MODELS, RepoSelect, RoleModelSelects, RunLimitInputs, dialogInputCls, useBranches, useRoleModelOptions } from "./taskDialog";
import { FolderBrowser } from "./folderBrowser";
import { DetailsMenu } from "./detailsMenu";
import type { EpicRunMode } from "@/shared/epics";
import { errorMessage } from "@/shared/errorMessage";

/** Spec 24: a child issue of the imported Jira issue, offered as a piece. */
type JiraChild = { key: string; title: string; description: string; include: boolean };

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
  // What a file import had to say, kept on screen until Done: the dialog
  // used to close behind a browser alert.
  const [importNotice, setImportNotice] = useState<string[]>([]);
  // Spec 24 decision 8: the imported issue's child issues, each ticked to
  // become a task under this one, and how those tasks should run.
  const [jiraChildren, setJiraChildren] = useState<JiraChild[]>([]);
  // The issue actually imported, not the text typed into the box: only this
  // key is known to be a real issue, so only this key is worth persisting.
  const [jiraKey, setJiraKey] = useState<string | null>(null);
  const [childrenRunMode, setChildrenRunMode] = useState<EpicRunMode>("ordered");
  const includedChildren = jiraChildren.filter((child) => child.include);
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
      if (result.notes.length === 0) { onClose(); return; }
      setImportNotice([`Imported ${result.cardIds.length} card${result.cardIds.length === 1 ? "" : "s"}.`, ...result.notes]);
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
      const draft = await api<{ key: string; title: string; description: string; children?: Omit<JiraChild, "include">[] }>(
        `/api/jira/issue?ref=${encodeURIComponent(ref)}`,
      );
      setJiraKey(draft.key);
      setTitle(draft.title);
      setDescription(draft.description);
      setJiraChildren((draft.children ?? []).map((child) => ({ ...child, include: true })));
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
  const [planCritic, setPlanCritic] = useState<boolean | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [openPr, setOpenPr] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [branches, setBranches] = useBranches(repoId);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const dirty = Boolean(title || description || jiraRef || roleModels.planner || roleModels.loop || roleModels.evaluator || maxIterations || timeoutMinutes || selectedBranch) || reviewPlanBeforeImplementation || grillMe || scopingAuthorsPlan || planCritic !== null || autoApprove || openPr || jiraKey !== null || jiraChildren.length > 0;

  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const requestClose = useCallback(() => {
    if (dirty) { setConfirmingDiscard(true); return; }
    onClose();
  }, [dirty, onClose]);
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
        planCritic,
        autoApprove,
        openPr,
        baseBranch: selectedBranch || null,
        jiraKey,
      };
      const created = await api<{ id: string }>("/api/cards", { json: request });
      // Jira already wrote the pieces: the ticked children become the tasks
      // of this card, which lands on its page as an epic.
      if (includedChildren.length > 0) {
        await api(`/api/cards/${created.id}/breakdown`, {
          json: {
            pieces: includedChildren.map(({ key, title, description }) => ({ title, description, jiraKey: key })),
            runMode: childrenRunMode,
          },
        });
        onCreated();
        router.push(`/card/${created.id}`);
        return;
      }
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
      footer={confirmingDiscard ? <DiscardPrompt question="Discard your unsaved task?" onKeep={() => setConfirmingDiscard(false)} onDiscard={onClose} /> : <>
        <span className="mr-auto self-center text-xs text-foreground/45">New tasks go to Backlog</span>
        <button type="button" onClick={requestClose} className="rounded-lg px-4 text-sm text-foreground/60">Cancel</button>
        <button type="button" onClick={() => create()} disabled={busy || !title.trim() || !repoId} className="rounded-lg bg-amber-600 px-5 text-sm font-semibold text-on-accent disabled:opacity-40">
          {busy ? "Creating…" : includedChildren.length > 0 ? `Create epic with ${includedChildren.length} task${includedChildren.length === 1 ? "" : "s"}` : "Create task"}
        </button>
        {/* The two ways to start rough sit behind the primary action rather
            than beside it, so a first task is one obvious button. */}
        {includedChildren.length === 0 && (
          <DetailsMenu detailsClassName="relative" summaryClassName="grid min-h-11 w-11 cursor-pointer list-none place-items-center rounded-lg bg-foreground/10 text-sm text-foreground/80 hover:bg-foreground/15" menuClassName="absolute bottom-12 right-0 z-30 w-64 rounded-xl border border-foreground/10 bg-surface p-1.5 shadow-2xl" ariaLabel="More ways to create" summary="▾">
            <button type="button" onClick={() => create("scope")} disabled={busy || !title.trim() || !repoId} title="Open the card on its scoping thread, where an assistant that reads the repository sharpens a rough ask" className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-foreground/[0.06] disabled:opacity-40">Create and scope</button>
            <button type="button" onClick={() => create("breakdown")} disabled={busy || !title.trim() || !repoId} title="Create the card and ask the scoping assistant for the pieces straight away" className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-foreground/[0.06] disabled:opacity-40">Create and break down</button>
          </DetailsMenu>
        )}
      </>}
    >
          {repoList.length === 0 ? <div className="space-y-2"><p className="text-sm text-foreground/60">No repositories yet. Browse for one, or register it in <Link href="/settings" className="text-amber-300 underline">Settings</Link>.</p><FolderBrowser onPick={registerRepo} onCreate={createRepo} onClone={cloneRepo} onError={setError} /></div> : <>
            {importNotice.length > 0 && (
              <div role="status" className="flex flex-col gap-1.5 rounded-lg border border-cyan-800/40 bg-cyan-950/20 p-3 text-sm">
                {importNotice.map((line, index) => <p key={index} className={index === 0 ? "font-medium text-cyan-300" : "text-foreground/75"}>{line}</p>)}
                <button type="button" onClick={onClose} className="mt-1 self-start rounded-lg bg-foreground/10 px-3 text-sm">Done</button>
              </div>
            )}
            <label className="block text-sm text-foreground/70">Title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={dialogInputCls} required /></label>
            {/* Folded: most tasks are typed, and the title is where typing
                starts. An import fills the title and description above. */}
            <details className="rounded-lg border border-foreground/10 bg-foreground/[0.02]" open={jiraChildren.length > 0 || undefined}>
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">Import from Jira or a file</summary>
              <div className="space-y-3 border-t border-foreground/10 p-3">
                <div className="flex items-end gap-2">
                  <label className="block grow text-sm text-foreground/70">Import from Jira<input value={jiraRef} onChange={(e) => setJiraRef(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void importFromJira(); } }} placeholder="Issue link or key, e.g. DEV-123" className={dialogInputCls} /></label>
                  <button type="button" onClick={() => void importFromJira()} disabled={importing || !jiraRef.trim()} className="rounded-lg bg-foreground/10 px-4 text-sm disabled:opacity-40">{importing ? "Importing…" : "Import"}</button>
                </div>
                <label className="block text-sm text-foreground/70">Import an exported file<input type="file" accept="application/json,.json" disabled={importing || !repoId} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void importFromFile(file); }} className={`${dialogInputCls} py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-foreground/10 file:px-2 file:py-1 file:text-sm file:text-foreground/80`} /></label>
                <p className="-mt-1 text-xs text-foreground/45">A card exported from this or another Radulf, with its scoping thread. Its cards go straight to Backlog for the repository selected below.</p>
              </div>
            </details>
            {jiraChildren.length > 0 && (
              <fieldset className="rounded-lg border border-cyan-800/40 bg-cyan-950/20 p-3">
                <legend className="px-1 text-sm font-medium text-cyan-300">{jiraChildren.length} child issue{jiraChildren.length === 1 ? "" : "s"} in Jira</legend>
                <p className="text-xs text-foreground/55">Ticked issues become tasks under this one, queued in this order, and this task becomes an epic that is done when they are.</p>
                <ul className="mt-1">
                  {jiraChildren.map((child, i) => (
                    <li key={child.key}>
                      <label className="flex min-h-11 items-center gap-2 text-sm">
                        <input type="checkbox" checked={child.include} onChange={(e) => setJiraChildren(jiraChildren.map((c, j) => (j === i ? { ...c, include: e.target.checked } : c)))} className="size-4 accent-amber-600" />
                        <span className="truncate">{child.title}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 flex flex-wrap gap-4 text-sm">
                  {(["ordered", "parallel"] as const).map((mode) => (
                    <label key={mode} className="flex min-h-11 items-center gap-2">
                      <input type="radio" name="jira-children-run-mode" checked={childrenRunMode === mode} onChange={() => setChildrenRunMode(mode)} className="size-4 accent-amber-600" />
                      {mode === "ordered" ? "Run in order" : "Run in parallel"}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <RepoSelect repos={repoList} value={repoId} onChange={(value) => { if (value === "__add__") { setAddingRepo(true); return; } setRepoId(value); setBranches([]); setSelectedBranch(""); setShowNewBranch(false); setNewBranchName(""); }}><option value="__add__">Add a repository…</option></RepoSelect>
            {addingRepo && <FolderBrowser onPick={registerRepo} onCreate={createRepo} onClone={cloneRepo} onError={setError} />}
            {repoId && <label className="block text-sm text-foreground/70">Branch<select value={selectedBranch} onChange={(e) => { const v = e.target.value; if (v === "__new__") { setShowNewBranch(true); setSelectedBranch(""); } else { setShowNewBranch(false); setSelectedBranch(v); } }} className={dialogInputCls}><option value="">Default branch</option>{branches.map((b) => <option key={b} value={b}>{b}</option>)}<option value="__new__">Add new branch…</option></select></label>}
            {showNewBranch && <div className="flex gap-2"><input value={newBranchName} onChange={(e) => setNewBranchName(e.target.value)} placeholder="Branch name" className="grow rounded-lg border border-foreground/10 bg-foreground/5 px-3 text-sm" /><button type="button" onClick={async () => { const name = newBranchName.trim(); if (!name) return; try { const repo = repoList.find((r) => r.id === repoId); if (!repo) return; await api(`/api/repos/${repoId}/branches`, { json: { name, from: repo.defaultBranch } }); setBranches((prev) => prev.includes(name) ? prev : [...prev, name]); setSelectedBranch(name); setShowNewBranch(false); setNewBranchName(""); } catch (e) { setError(errorMessage(e)); }}} disabled={!newBranchName.trim()} className="rounded-lg bg-foreground/10 px-3 text-sm disabled:opacity-40">Add</button></div>}
            <label className="block text-sm text-foreground/70">Description and definition of done<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={7} className={`${dialogInputCls} py-2 text-sm`} placeholder="Describe the outcome, constraints, and how the work can be verified — or start rough and use Create and scope." /></label>
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
                <label className="flex items-center gap-2 text-sm text-foreground/70">
                  Plan critic
                  <select
                    value={planCritic === null ? "default" : planCritic ? "on" : "off"}
                    onChange={(e) => setPlanCritic(e.target.value === "default" ? null : e.target.value === "on")}
                    className="bg-foreground/5 border border-foreground/10 rounded px-2 py-1 text-sm"
                  >
                    <option value="default">Default (on for breakdown pieces)</option>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </label>
                <DeliveryOptions repoId={repoId} autoApprove={autoApprove} setAutoApprove={setAutoApprove} openPr={openPr} setOpenPr={setOpenPr} />
              </div>
            </details>
          </>}
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </DialogShell>
  );
}
