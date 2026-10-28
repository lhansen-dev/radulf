"use client";
import { useSyncExternalStore } from "react";

const KEY = "radulf.workHref";

/** The Work feed as it was last scoped (repo, view, search) in this tab, so
 * a page's "← Work" lands back on the same list rather than the full feed.
 * Per tab, in sessionStorage: the scope is where the operator was, not a
 * preference. */
export function rememberWorkHref(href: string): void {
  try {
    sessionStorage.setItem(KEY, href);
  } catch {
    // Storage blocked: the link falls back to the full feed.
  }
}

function readWorkHref(): string {
  try {
    return sessionStorage.getItem(KEY) ?? "/";
  } catch {
    return "/";
  }
}

const subscribe = () => () => {};

/** Where "← Work" should go. "/" on the server and until storage is read. */
export function useWorkHref(): string {
  return useSyncExternalStore(subscribe, readWorkHref, () => "/");
}
