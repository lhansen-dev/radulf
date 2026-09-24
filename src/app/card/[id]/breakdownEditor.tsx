"use client";
import { useEffect, useState } from "react";
import { api, type Repo } from "../../ui/api";
import type { EpicRunMode } from "@/shared/epics";
import { errorMessage } from "@/shared/errorMessage";

/** One piece as the editor holds it. `repoId` unset means the epic's own repository. */
export type BreakdownPiece = { title: string; description: string; repoId?: string };

const RUN_MODE_LABELS: Record<EpicRunMode, string> = {
  ordered: "In order",
  parallel: "In parallel",
  graph: "As a graph",
};

const RUN_MODE_HELP: Record<EpicRunMode, string> = {
  ordered:
    "Each task starts only once the tasks before it are done. Pick this when a later task builds on an earlier one.",
  parallel:
    "Every task is eligible at once, up to the repository's concurrency cap in Settings. Pick this when the tasks stand alone.",
  graph:
    "Each task starts once the tasks it depends on are done. Pick this when only some tasks build on others.",
};

/** What applying did, in the panel's words. */
export function breakdownNotice(count: number, runMode: EpicRunMode): string {
  return `Queued ${count} task${count === 1 ? "" : "s"} under this epic, to run ${runMode === "ordered" ? "in order" : "in parallel"}.`;
}

/**
 * Spec 24: the breakdown the operator edits before it is applied. Owns the
 * pieces and the run mode, and applying posts them as the card's breakdown.
 * Repositories are fetched only to offer a per-piece choice, so an install
 * with one repository never sees the select.
 */
export function BreakdownEditor({
  cardId,
  homeRepoId,
  initialPieces,
  initialRunMode,
  onApplied,
  onDiscard,
}: {
  cardId: string;
  /** The epic's own repository: the default for every piece. */
  homeRepoId: string | null;
  initialPieces: BreakdownPiece[];
  initialRunMode: EpicRunMode;
  onApplied: (notice: string) => void;
  onDiscard: () => void;
}) {
  const [pieces, setPieces] = useState(initialPieces);
  const [runMode, setRunMode] = useState(initialRunMode);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api<Repo[]>("/api/repos")
      .then((rows) => { if (live && Array.isArray(rows)) setRepos(rows); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const update = (index: number, patch: Partial<BreakdownPiece>) =>
    setPieces(pieces.map((piece, i) => (i === index ? { ...piece, ...patch } : piece)));
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= pieces.length) return;
    const next = [...pieces];
    [next[index], next[target]] = [next[target], next[index]];
    setPieces(next);
  };
  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/cards/${cardId}/breakdown`, {
        json: {
          pieces: pieces.map(({ title, description, repoId }) => ({
            title,
            description,
            ...(repoId && repoId !== homeRepoId ? { repoId } : {}),
          })),
          runMode,
        },
      });
      onApplied(breakdownNotice(pieces.length, runMode));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const fieldCls = "w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm";
  const buttonCls = "min-h-11 rounded-lg px-3 text-sm disabled:opacity-40";
  const count = pieces.length;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-cyan-800/40 bg-cyan-950/20 p-3">
      <p className="text-sm font-medium text-cyan-300">
        Proposed breakdown into {count} task{count === 1 ? "" : "s"}. Edit anything, then queue.
      </p>
      <p className="text-xs text-foreground/55">
        Applying makes this card the epic. The tasks are queued in this order with its settings, and the
        epic is done when they are.
      </p>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs text-foreground/70">Run mode</legend>
        <div className="flex flex-wrap gap-4">
          {(Object.keys(RUN_MODE_LABELS) as EpicRunMode[]).map((mode) => (
            <label key={mode} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="radio"
                name={`run-mode-${cardId}`}
                checked={runMode === mode}
                onChange={() => setRunMode(mode)}
                disabled={busy}
                className="size-4 accent-amber-600"
              />
              {RUN_MODE_LABELS[mode]}
            </label>
          ))}
        </div>
        <p className="text-xs text-foreground/50">{RUN_MODE_HELP[runMode]}</p>
      </fieldset>
      {pieces.map((piece, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] p-2.5">
          <label className="block text-xs text-foreground/70">
            {i + 1}. Title
            <input value={piece.title} onChange={(e) => update(i, { title: e.target.value })} disabled={busy} className={`mt-1 ${fieldCls}`} />
          </label>
          <label className="block text-xs text-foreground/70">
            Description
            <textarea value={piece.description} onChange={(e) => update(i, { description: e.target.value })} rows={6} disabled={busy} className={`mt-1 font-mono ${fieldCls}`} />
          </label>
          {repos.length > 1 && (
            <label className="block text-xs text-foreground/70">
              Repository
              <select
                aria-label={`${i + 1}. Repository`}
                value={piece.repoId ?? homeRepoId ?? ""}
                onChange={(e) => update(i, { repoId: e.target.value })}
                disabled={busy}
                className={`mt-1 ${fieldCls}`}
              >
                {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
              </select>
            </label>
          )}
          <div className="flex items-center gap-1 self-end">
            <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move task ${i + 1} up`} className="size-11 rounded-md text-lg text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-20">↑</button>
            <button type="button" disabled={busy || i === count - 1} onClick={() => move(i, 1)} aria-label={`Move task ${i + 1} down`} className="size-11 rounded-md text-lg text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-20">↓</button>
            {count > 1 && (
              <button type="button" onClick={() => setPieces(pieces.filter((_, j) => j !== i))} disabled={busy} className="min-h-11 px-2 text-xs text-foreground/50 hover:text-red-300">
                Drop this task
              </button>
            )}
          </div>
        </div>
      ))}
      <button type="button" onClick={() => setPieces([...pieces, { title: "", description: "" }])} disabled={busy} className={`${buttonCls} self-start bg-foreground/10`}>
        ＋ Add a task
      </button>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDiscard} disabled={busy} className={`${buttonCls} text-foreground/60`}>Discard</button>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={busy || count === 0 || pieces.some((piece) => !piece.title.trim())}
          className={`${buttonCls} bg-amber-600 font-medium text-on-accent`}
        >
          {busy ? "Queueing…" : `Queue ${count} task${count === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
