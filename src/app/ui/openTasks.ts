"use client";
import { useCallback, useEffect, useState } from "react";

const KEY = "radulf.openTasks";
/** Enough for a desk's worth of work in flight; the oldest falls off first. */
const MAX_OPEN = 8;

/** The task a page path is about: a card page or its review page. */
export function taskIdFromPath(pathname: string): string | null {
  const match = /^\/(?:card|review)\/([^/?#]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function readOpenTasks(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(-MAX_OPEN) : [];
  } catch {
    return [];
  }
}

function writeOpenTasks(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked or full: the strip still works for this page load.
  }
}

/**
 * The tasks open in the shell's tab strip, oldest first, kept in this
 * browser's localStorage as a per-viewer convenience. Visiting a task's page
 * opens its tab; closing one is explicit. `prune` drops tabs whose task no
 * longer exists once a card list says so.
 */
export function useOpenTasks(pathname: string) {
  // Empty on the server and on the first client render, so both agree; the
  // stored list arrives with the first effect.
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const restore = () => setIds(readOpenTasks());
    restore();
  }, []);
  useEffect(() => {
    const open = (id: string) =>
      setIds((prev) => {
        if (prev.includes(id)) return prev;
        const next = [...prev, id].slice(-MAX_OPEN);
        writeOpenTasks(next);
        return next;
      });
    const id = taskIdFromPath(pathname);
    if (id) open(id);
  }, [pathname]);
  const close = useCallback((id: string) => {
    setIds((prev) => {
      const next = prev.filter((open) => open !== id);
      writeOpenTasks(next);
      return next;
    });
  }, []);
  const prune = useCallback((existing: Set<string>) => {
    setIds((prev) => {
      const next = prev.filter((open) => existing.has(open));
      if (next.length === prev.length) return prev;
      writeOpenTasks(next);
      return next;
    });
  }, []);
  return { ids, close, prune };
}
