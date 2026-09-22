import type { CardStatus } from "@/db/schema";

export type { CardStatus };

/** A run is in flight; pulling the card back cancels it. */
export const RUNNING_STATUSES: readonly CardStatus[] = ["planning", "looping", "evaluating"];

/** What the board's Active section shows. */
export const ACTIVE_STATUSES: readonly CardStatus[] = ["planning", "ready", "looping", "evaluating", "paused", "reviewing"];

/** Waiting on a human decision. */
export const ATTENTION_STATUSES: readonly CardStatus[] = ["review", "plan_review", "needs_attention"];

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
