import { asc, eq } from "drizzle-orm";
import { db, cards, type CardStatus } from "@/db";
import { getCard, type Card } from "./cards";

/**
 * Spec 24: an epic is a card with children. What the orchestrator and the
 * routes need to know about that relationship lives here; the transitions
 * themselves stay in the orchestrator, with every other card move.
 */

/** One piece of a breakdown, as the editor or the Jira import hands it over.
 * `repoId` unset means the epic's own repository. */
export type BreakdownPiece = { title: string; description: string; repoId?: string | null };

/** Statuses in which a piece no longer holds up an ordered epic, and which
 * count towards the epic finishing. */
export const FINISHED_STATUSES: readonly CardStatus[] = ["done", "abandoned"];

/** The epic's pieces, in queue order. */
export function listChildren(parentCardId: string): Card[] {
  return db
    .select()
    .from(cards)
    .where(eq(cards.parentCardId, parentCardId))
    .orderBy(asc(cards.position))
    .all();
}

export function hasChildren(cardId: string): boolean {
  return (
    db.select({ id: cards.id }).from(cards).where(eq(cards.parentCardId, cardId)).limit(1).get() !==
    undefined
  );
}

/**
 * Spec 24 decision 4: under `ordered`, a piece waits while any sibling queued
 * before it is still unfinished. Position is the order the breakdown gave the
 * pieces, and the order the operator sees and can change in the queue.
 */
export function heldByEpicOrder(card: Pick<Card, "id" | "parentCardId" | "position">): boolean {
  if (!card.parentCardId) return false;
  if (getCard(card.parentCardId)?.runMode !== "ordered") return false;
  return listChildren(card.parentCardId).some(
    (sibling) =>
      sibling.id !== card.id &&
      sibling.position < card.position &&
      !FINISHED_STATUSES.includes(sibling.status),
  );
}

/** Spec 24 decision 6: every piece finished, and at least one of them done. */
export function epicFinished(children: Pick<Card, "status">[]): boolean {
  return (
    children.some((child) => child.status === "done") &&
    children.every((child) => FINISHED_STATUSES.includes(child.status))
  );
}
