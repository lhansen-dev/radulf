import type { CardStatus } from "@/db/schema";

export type { CardStatus };

/** A run is in flight; pulling the card back cancels it. */
export const RUNNING_STATUSES: readonly CardStatus[] = ["planning", "looping", "evaluating"];

/** What the board's Active section shows. */
export const ACTIVE_STATUSES: readonly CardStatus[] = ["planning", "ready", "looping", "evaluating", "paused", "reviewing"];

/**
 * Spec 17: statuses in which a scoping session can still change what gets
 * planned, so the thread, a split, and a scoping-authored plan are all
 * offered. Past these the card has a plan or a run that the conversation can
 * no longer steer.
 */
export const SCOPABLE_STATUSES: readonly CardStatus[] = ["backlog", "todo", "needs_attention"];

/** Waiting on a human decision. */
export const ATTENTION_STATUSES: readonly CardStatus[] = ["review", "plan_review", "needs_attention"];

/** A human may pull the card back to Backlog from these; a live run is cancelled. */
export const PULLBACK_STATUSES: readonly CardStatus[] = [
  "todo", "planning", "ready", "looping", "evaluating", "review", "plan_review", "needs_attention", "paused",
];

export const STATUS_LABELS: Record<CardStatus, string> = {
  backlog: "Backlog",
  todo: "Queued",
  planning: "Planning",
  plan_review: "Plan ready for review",
  ready: "Ready to run",
  looping: "Running",
  evaluating: "Evaluating",
  paused: "Paused",
  review: "Ready for review",
  reviewing: "Applying review",
  needs_attention: "Needs attention",
  done: "Completed",
  abandoned: "Abandoned",
};
