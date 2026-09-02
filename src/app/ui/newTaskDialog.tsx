"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CreateCardRequest } from "@/shared/cardRequests";
import { api, type PlannerMessage, type Repo } from "./api";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude subscription)",
  chatgpt: "ChatGPT (Codex subscription)",
  copilot: "GitHub Copilot (subscription)",
  omlx: "oMLX (local)",
  openrouter: "OpenRouter",
};

function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

export function NewTaskDialog({ repos, onClose, onCreated, defaultRepoId }: { repos: Repo[]; onClose: () => void; onCreated: () => void; defaultRepoId?: string }) {
  const [title, setTitle] = useState("");
  const [repoId, setRepoId] = useState(defaultRepoId && repos.some((r) => r.id === defaultRepoId) ? defaultRepoId : repos[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [plannerModel, setPlannerModel] = useState("");
  const [loopModel, setLoopModel] = useState("");
  const [evaluatorModel, setEvaluatorModel] = useState("");
  const [plannerProvider, setPlannerProvider] = useState("");
  const [loopProvider, setLoopProvider] = useState("");
  const [evaluatorProvider, setEvaluatorProvider] = useState("");
  const [maxIterations, setMaxIterations] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("");
  const [models, setModels] = useState<{ planner: { value: string; displayName: string }[]; loop: { value: string; displayName: string }[]; evaluator: { value: string; displayName: string }[] }>({ planner: [], loop: [], evaluator: [] });
  const [showPlanner, setShowPlanner] = useState(false);
  const [reviewPlanBeforeImplementation, setReviewPlanBeforeImplementation] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [openPr, setOpenPr] = useState(false);
  // Spec 15: PR delivery is only offerable when `gh` is installed and
  // authenticated AND the selected repo has an `origin`. Tagged with the repo
  // it describes, so a stale answer for the previously selected repo reads as
  // "unknown" rather than as permission to tick the box.
  const [prReady, setPrReady] = useState<{ repoId: string; ok: boolean; detail: string | null; hasRemote: boolean | null } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const prStatus = prReady && prReady.repoId === repoId ? prReady : null;
  const prDeliverable = Boolean(prStatus?.ok && prStatus.hasRemote);
  // Say which of the three preconditions is missing — install a tool, run a
  // login, and add a remote are three different next actions.
  const prBlockedReason = prStatus === null || prDeliverable
    ? null
    : prStatus.ok
      ? "This repo has no `origin` remote to open a pull request against."
      : prStatus.detail;
  const dirty = Boolean(title || description || plannerModel || loopModel || evaluatorModel || maxIterations || timeoutMinutes || selectedBranch) || reviewPlanBeforeImplementation || autoApprove || openPr;

  const requestClose = useCallback(() => {
    if (dirty && !confirm("Discard your unsaved task?")) return;
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

  useEffect(() => {
    if (!repoId) return;
    fetch(`/api/repos/${repoId}/branches`)
      .then(async (res) => {
        if (!res.ok) { setBranches([]); return; }
        const data = await res.json();
        if (Array.isArray(data)) {
          setBranches(data as string[]);
        } else {
          setBranches([]);
        }
      })
      .catch(() => { setBranches([]); });
  }, [repoId]);

  async function create() {
    setBusy(true); setError("");
    try {
      const request: CreateCardRequest = {
        repoId,
        title,
        description,
        plannerModel,
        loopModel,
        evaluatorModel,
        maxIterations,
        timeoutMinutes,
        reviewPlanBeforeImplementation,
        autoApprove,
        openPr,
        baseBranch: selectedBranch || null,
      };
      await api("/api/cards", { json: request });
      onCreated();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="new-task-title" className="flex max-h-[min(92dvh,800px)] w-full flex-col rounded-t-2xl border border-foreground/10 bg-surface shadow-2xl sm:max-w-xl sm:rounded-2xl">
        <header className="flex shrink-0 items-center border-b border-foreground/10 px-4 py-3">
          <h2 id="new-task-title" className="grow text-lg font-semibold">New task</h2>
          <button type="button" onClick={requestClose} aria-label="Close new task" className="grid size-11 place-items-center rounded-lg text-xl text-foreground/55 hover:bg-foreground/[0.06]">×</button>
        </header>
        <div className="min-h-0 grow space-y-4 overflow-y-auto p-4 sm:p-5">
          {repos.length === 0 ? <p className="text-sm text-foreground/60">Register a repository in <Link href="/settings" className="text-amber-300 underline">Settings</Link> first.</p> : <>
            <label className="block text-sm text-foreground/70">Title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3" required /></label>
            <label className="block text-sm text-foreground/70">Repository<select value={repoId} onChange={(e) => { setRepoId(e.target.value); setBranches([]); setSelectedBranch(""); setShowNewBranch(false); setNewBranchName(""); }} className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3">{repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
            {repoId && <label className="block text-sm text-foreground/70">Branch<select value={selectedBranch} onChange={(e) => { const v = e.target.value; if (v === "__new__") { setShowNewBranch(true); setSelectedBranch(""); } else { setShowNewBranch(false); setSelectedBranch(v); } }} className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3"><option value="">Default branch</option>{branches.map((b) => <option key={b} value={b}>{b}</option>)}<option value="__new__">Add new branch…</option></select></label>}
            {showNewBranch && <div className="flex gap-2"><input value={newBranchName} onChange={(e) => setNewBranchName(e.target.value)} placeholder="Branch name" className="grow rounded-lg border border-foreground/10 bg-foreground/5 px-3 text-sm" /><button type="button" onClick={async () => { const name = newBranchName.trim(); if (!name) return; try { const repo = repos.find((r) => r.id === repoId); if (!repo) return; await api(`/api/repos/${repoId}/branches`, { json: { name, from: repo.defaultBranch } }); setBranches((prev) => prev.includes(name) ? prev : [...prev, name]); setSelectedBranch(name); setShowNewBranch(false); setNewBranchName(""); } catch { /* ignore */ }}} disabled={!newBranchName.trim()} className="rounded-lg bg-foreground/10 px-3 text-sm disabled:opacity-40">Add</button></div>}
            <label className="block text-sm text-foreground/70">Description and definition of done<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={7} className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm" placeholder="Describe the outcome, constraints, and how Ralph can verify the work." /></label>
            <details className="rounded-lg border border-foreground/10 bg-foreground/[0.02]">
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">Advanced</summary>
              <div className="space-y-3 border-t border-foreground/10 p-3">
                <ModelSelect label="Planner model" providerId={plannerProvider} value={plannerModel} setValue={setPlannerModel} models={models.planner} inputId="planner-model-input" datalistId="planner-models" />
                <ModelSelect label="Loop model" providerId={loopProvider} value={loopModel} setValue={setLoopModel} models={models.loop} inputId="loop-model-input" datalistId="loop-models" />
                <ModelSelect label="Evaluator model" providerId={evaluatorProvider} value={evaluatorModel} setValue={setEvaluatorModel} models={models.evaluator} inputId="evaluator-model-input" datalistId="evaluator-models" />
                <div className="grid grid-cols-2 gap-3"><label className="text-sm text-foreground/70">Iteration cap<input type="number" min="1" value={maxIterations} onChange={(e) => setMaxIterations(e.target.value)} placeholder="Default" className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3" /></label><label className="text-sm text-foreground/70">Timeout (min)<input type="number" min="1" value={timeoutMinutes} onChange={(e) => setTimeoutMinutes(e.target.value)} placeholder="Default" className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3" /></label></div>
                <label className="flex items-center gap-2 text-sm text-foreground/70"><input type="checkbox" checked={reviewPlanBeforeImplementation} onChange={(e) => setReviewPlanBeforeImplementation(e.target.checked)} className="size-4 accent-amber-600" />Review plan before implementation</label>
                <label className="flex items-center gap-2 text-sm text-foreground/70"><input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} className="size-4 accent-amber-600" />Auto-approve on evaluator pass (skip human review)</label>
                {autoApprove && <p className="text-xs text-amber-400/80">The evaluator&rsquo;s approval merges straight to the base branch with no human review. Integrity and merge-conflict checks still run. This card keeps this setting even when the workspace-wide toggle is off.</p>}
                <label className="flex items-center gap-2 text-sm text-foreground/70"><input type="checkbox" checked={openPr} disabled={!prDeliverable} onChange={(e) => setOpenPr(e.target.checked)} className="size-4 accent-amber-600 disabled:opacity-40" />Open a pull request instead of merging</label>
                {prBlockedReason && <p className="text-xs text-foreground/45">{prBlockedReason}</p>}
                {openPr && <p className="text-xs text-foreground/55">On approval the branch is pushed to <code>origin</code> and a pull request is opened against the base branch. Nothing is merged locally, and Radulf never merges the pull request.</p>}
                <button type="button" onClick={() => setShowPlanner((value) => !value)} className="w-full rounded-lg bg-foreground/[0.06] px-3 text-left text-sm">{showPlanner ? "Hide planner chat" : "Open planner chat"}</button>
                {showPlanner && <ConversationPlanner onInsert={(text) => setDescription((current) => current ? `${current}\n\n${text}` : text)} />}
              </div>
            </details>
          </>}
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-foreground/10 bg-surface p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] sm:p-4">
          <span className="mr-auto self-center text-xs text-foreground/45">New tasks go to Backlog</span>
          <button type="button" onClick={requestClose} className="rounded-lg px-4 text-sm text-foreground/60">Cancel</button>
          <button type="button" onClick={create} disabled={busy || !title.trim() || !repoId} className="rounded-lg bg-amber-600 px-5 text-sm font-semibold text-on-accent disabled:opacity-40">{busy ? "Creating…" : "Create task"}</button>
        </footer>
      </div>
    </div>
  );
}

export function ModelSelect({ label, providerId, value, setValue, models, inputId, datalistId }: { label: string; providerId: string; value: string; setValue: (value: string) => void; models: { value: string; displayName: string }[]; inputId: string; datalistId: string }) {
  return (
    <div>
      <label htmlFor={inputId} className="block text-sm text-foreground/70">{label}</label>
      <p className="mt-0.5 text-xs text-foreground/40">Provider: {providerLabel(providerId)}</p>
      <input
        id={inputId}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Default from settings"
        className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3"
        list={datalistId}
      />
      <datalist id={datalistId}>
        {models.map((model) => (
          <option key={model.value} value={model.value}>
            {model.displayName}
          </option>
        ))}
      </datalist>
      {models.length > 0 && models.length <= 30 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {models.map((model) => (
            <button
              key={model.value}
              type="button"
              onClick={() => setValue(model.value)}
              className={`text-xs rounded px-2 py-1 border ${
                value === model.value
                  ? "border-amber-500 text-amber-400"
                  : "border-foreground/10 text-foreground/60 hover:text-foreground"
              }`}
            >
              {model.displayName}
            </button>
          ))}
        </div>
      )}
      {models.length > 30 && (
        <p className="mt-1 text-xs text-foreground/40">Type in the model field to search the list.</p>
      )}
    </div>
  );
}

function ConversationPlanner({ onInsert }: { onInsert: (text: string) => void }) {
  const [messages, setMessages] = useState<PlannerMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send() {
    const text = input.trim(); if (!text || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next); setInput(""); setBusy(true); setError("");
    try { const result = await api<{ reply: string }>("/api/planner-chat", { json: { messages: next } }); setMessages([...next, { role: "assistant", content: result.reply }]); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="rounded-lg border border-foreground/10 bg-foreground/[0.06] p-3"><div className="max-h-64 space-y-2 overflow-y-auto">{messages.length === 0 && <p className="text-xs text-foreground/45">Ask the planner to clarify scope or acceptance criteria.</p>}{messages.map((message, index) => <div key={index} className={`rounded-lg p-2 text-sm ${message.role === "user" ? "ml-6 bg-amber-500/10" : "mr-6 bg-foreground/[0.05]"}`}><p>{message.content}</p>{message.role === "assistant" && <button type="button" onClick={() => onInsert(message.content)} className="mt-1 min-h-11 text-xs text-amber-300 underline">Insert into description</button>}</div>)}</div>{error && <p className="mt-2 text-xs text-red-300">{error}</p>}<div className="mt-2 flex gap-2"><input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void send(); } }} placeholder="Ask the planner…" className="min-w-0 grow rounded-lg border border-foreground/10 bg-foreground/5 px-3 text-sm"/><button type="button" onClick={send} disabled={busy || !input.trim()} className="rounded-lg bg-foreground/10 px-3 text-sm disabled:opacity-40">Send</button></div></div>;
}
