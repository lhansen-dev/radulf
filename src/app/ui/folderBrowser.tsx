"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { errorMessage } from "@/shared/errorMessage";

export type FolderEntry = { name: string; path: string; isGitRepo: boolean };
type Listing = {
  root: string;
  path: string;
  parent: string | null;
  entries: FolderEntry[];
  truncated: boolean;
};

/**
 * Browse the server's directories and pick a repository folder.
 *
 * Replaces the macOS-only native chooser, which opened a dialog on the machine
 * running the server: unavailable on Linux, and unusable from a phone on any
 * platform since the dialog appeared on the host's screen rather than in the
 * browser. Everything here is confined server-side to the configured root.
 */
export function FolderBrowser({
  onPick,
  onCreate,
  onError,
}: {
  onPick: (path: string) => void;
  /** When given, the browser also offers to create a fresh repository inside
   * the folder being viewed. A rejection is reported through `onError`. */
  onCreate?: (parentPath: string, name: string) => Promise<void>;
  /** Surfaced by the caller next to its own form errors. */
  onError?: (message: string) => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const create = () => {
    if (!onCreate || !listing || creating || !newName.trim()) return;
    setCreating(true);
    onCreate(listing.path, newName.trim())
      .then(() => setNewName(""))
      .catch((cause) => onError?.(errorMessage(cause)))
      .finally(() => setCreating(false));
  };

  // Deliberately does not flip `loading` itself: the mount effect calls this
  // synchronously, and a synchronous setState inside an effect cascades
  // renders. `loading` starts true for the first load, and navigation sets it
  // from the click handler.
  const load = useCallback((path: string | null) => {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    return api<Listing>(`/api/folder-browser${query}`)
      .then((result) => {
        // Defensive: a listing that arrives in an unexpected shape should show
        // as empty, not throw inside a dialog the user is mid-way through.
        setListing({ ...result, entries: Array.isArray(result?.entries) ? result.entries : [] });
        setError("");
      })
      .catch((cause) => {
        const message = errorMessage(cause);
        setError(message);
        onError?.(message);
      })
      .finally(() => setLoading(false));
  }, [onError]);

  useEffect(() => { void load(null); }, [load]);

  return (
    <div className="rounded-lg border border-foreground/10 bg-background">
      <div className="flex items-center gap-2 border-b border-foreground/10 px-2 py-2">
        <button
          type="button"
          onClick={() => { if (!listing?.parent) return; setLoading(true); void load(listing.parent); }}
          disabled={!listing?.parent || loading}
          aria-label="Go to parent folder"
          className="min-h-11 shrink-0 rounded-lg px-2 text-sm text-foreground/70 hover:bg-foreground/[0.06] disabled:opacity-30"
        >
          ↑
        </button>
        <p title={listing?.path} className="min-w-0 grow truncate font-mono text-xs text-foreground/55">
          {listing?.path ?? "…"}
        </p>
        <button
          type="button"
          onClick={() => listing && onPick(listing.path)}
          disabled={!listing || loading}
          className="min-h-11 shrink-0 rounded-lg bg-foreground/[0.08] px-3 text-xs font-medium hover:bg-foreground/[0.12] disabled:opacity-40"
        >
          Use this folder
        </button>
      </div>
      {onCreate && (
        <div className="flex items-center gap-2 border-b border-foreground/10 px-2 py-2">
          <input
            aria-label="New repository name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); create(); } }}
            placeholder="New repository name"
            className="min-h-11 min-w-0 grow rounded-lg border border-foreground/10 bg-foreground/5 px-3 text-sm"
          />
          <button
            type="button"
            onClick={create}
            disabled={!listing || loading || creating || !newName.trim()}
            className="min-h-11 shrink-0 rounded-lg bg-foreground/[0.08] px-3 text-xs font-medium hover:bg-foreground/[0.12] disabled:opacity-40"
          >
            {creating ? "Creating…" : "Create here"}
          </button>
        </div>
      )}
      <ul aria-label="Folders" className="max-h-64 divide-y divide-foreground/[0.07] overflow-y-auto">
        {loading && <li className="px-3 py-3 text-sm text-foreground/45">Loading…</li>}
        {!loading && error && <li role="alert" className="px-3 py-3 text-sm text-red-400">{error}</li>}
        {!loading && !error && listing && listing.entries.length === 0 && (
          <li className="px-3 py-3 text-sm text-foreground/45">No folders here.</li>
        )}
        {!loading && !error && listing?.entries.map((entry) => (
          <li key={entry.path} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setLoading(true); void load(entry.path); }}
              className="flex min-h-11 min-w-0 grow items-center gap-2 px-3 text-left text-sm hover:bg-foreground/[0.05]"
            >
              <span aria-hidden className="text-foreground/35">/</span>
              <span className="min-w-0 truncate">{entry.name}</span>
              {entry.isGitRepo && (
                <span className="shrink-0 rounded border border-amber-500/40 px-1.5 py-0.5 text-[11px] text-amber-300/90">
                  git
                </span>
              )}
            </button>
            {entry.isGitRepo && (
              <button
                type="button"
                onClick={() => onPick(entry.path)}
                className="mr-2 min-h-11 shrink-0 rounded-lg px-2 text-xs text-amber-300 hover:bg-amber-500/10"
              >
                Select
              </button>
            )}
          </li>
        ))}
        {listing?.truncated && (
          <li className="px-3 py-2 text-xs text-foreground/40">
            Showing the first 500 folders. Narrow the browsable root in Settings if this is not enough.
          </li>
        )}
      </ul>
    </div>
  );
}
