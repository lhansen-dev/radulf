import { asc, eq } from "drizzle-orm";
import { db, cards, type CardStatus } from "@/db";
import { getCard, type Card } from "./cards";

/**
 * Spec 24: an epic is a card with children. What the orchestrator and the
 * routes need to know about that relationship lives here; the transitions
 * themselves stay in the orchestrator, with every other card move.
 */

/** One piece of a breakdown, as the editor or the Jira import hands it over.
 * `repoId` unset means the epic's own repository. `dependsOn` (spec 28) holds
 * 0-based indexes of sibling pieces in the same breakdown. */
export type BreakdownPiece = {
  title: string;
  description: string;
  repoId?: string | null;
  dependsOn?: number[];
};

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

/** Spec 28: the siblings a piece depends on that are not yet done or
 * abandoned. Ids that match no sibling are ignored. */
export function unmetDependencies(
  card: Pick<Card, "id" | "dependsOn">,
  siblings: Pick<Card, "id" | "status">[],
): Pick<Card, "id" | "status">[] {
  const wanted = new Set(card.dependsOn ?? []);
  return siblings.filter(
    (sibling) => wanted.has(sibling.id) && !FINISHED_STATUSES.includes(sibling.status),
  );
}

/** Spec 28: the siblings a piece depends on that were abandoned. */
export function abandonedDependencies(
  card: Pick<Card, "id" | "dependsOn">,
  siblings: Pick<Card, "id" | "status">[],
): Pick<Card, "id" | "status">[] {
  const wanted = new Set(card.dependsOn ?? []);
  return siblings.filter((sibling) => wanted.has(sibling.id) && sibling.status === "abandoned");
}

/**
 * Spec 24 decision 4: under `ordered`, a piece waits while any sibling queued
 * before it is still unfinished. Position is the order the breakdown gave the
 * pieces, and the order the operator sees and can change in the queue.
 *
 * Spec 28: under `graph`, a piece waits while any sibling named in its
 * `dependsOn` is still unfinished. `parallel` holds nothing back.
 */
export function heldByEpicOrder(
  card: Pick<Card, "id" | "parentCardId" | "position" | "dependsOn">,
): boolean {
  if (!card.parentCardId) return false;
  const runMode = getCard(card.parentCardId)?.runMode;
  if (runMode === "graph") {
    return unmetDependencies(card, listChildren(card.parentCardId)).length > 0;
  }
  if (runMode !== "ordered") return false;
  return listChildren(card.parentCardId).some(
    (sibling) =>
      sibling.id !== card.id &&
      sibling.position < card.position &&
      !FINISHED_STATUSES.includes(sibling.status),
  );
}

/**
 * Spec 28: depth-first search over a breakdown's dependency graph (an edge
 * from each piece to every index in its `dependsOn`; out-of-range indexes are
 * ignored). Returns the first cycle found as a list of indexes starting and
 * ending with the same index (e.g. `[0, 2, 0]`), or null when acyclic.
 */
export function findDependencyCycle(pieces: { dependsOn?: number[] }[]): number[] | null {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Array<number>(pieces.length).fill(WHITE);
  const path: number[] = [];

  const visit = (index: number): number[] | null => {
    colour[index] = GREY;
    path.push(index);
    for (const next of pieces[index].dependsOn ?? []) {
      if (!Number.isInteger(next) || next < 0 || next >= pieces.length) continue;
      if (colour[next] === GREY) return [...path.slice(path.indexOf(next)), next];
      if (colour[next] === WHITE) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    path.pop();
    colour[index] = BLACK;
    return null;
  };

  for (let index = 0; index < pieces.length; index++) {
    if (colour[index] !== WHITE) continue;
    const cycle = visit(index);
    if (cycle) return cycle;
  }
  return null;
}

/** Spec 24 decision 6: every piece finished, and at least one of them done. */
export function epicFinished(children: Pick<Card, "status">[]): boolean {
  return (
    children.some((child) => child.status === "done") &&
    children.every((child) => FINISHED_STATUSES.includes(child.status))
  );
}
