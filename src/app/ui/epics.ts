import type { BoardCard } from "./api";

/** Spec 24: an epic on the feed, with its pieces in queue order. */
export type EpicGroup = { epic: BoardCard; tasks: BoardCard[] };

/**
 * The epics among a feed's cards. An epic is any card another card points at
 * through `parentCardId`; a piece whose epic is not in the list (deleted, or
 * not loaded) reads as a plain card. Groups are newest-updated first, which
 * puts the epic something just happened to at the top.
 */
export function groupEpics(cards: BoardCard[]): {
  epics: EpicGroup[];
  /** Each piece's epic, for the row that names it. */
  parentOf: Map<string, BoardCard>;
  epicIds: Set<string>;
} {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const tasksByEpic = new Map<string, BoardCard[]>();
  const parentOf = new Map<string, BoardCard>();
  for (const card of cards) {
    const epic = card.parentCardId ? byId.get(card.parentCardId) : undefined;
    if (!epic) continue;
    parentOf.set(card.id, epic);
    tasksByEpic.set(epic.id, [...(tasksByEpic.get(epic.id) ?? []), card]);
  }
  const epics = [...tasksByEpic]
    .map(([id, tasks]) => ({ epic: byId.get(id)!, tasks: tasks.sort((a, b) => a.position - b.position) }))
    .sort((a, b) => b.epic.updatedAt.localeCompare(a.epic.updatedAt));
  return { epics, parentOf, epicIds: new Set(tasksByEpic.keys()) };
}

/**
 * Spec 28: the siblings a queued piece is still waiting on, so the feed can
 * say why it has not started. Empty unless the piece is in Todo: under
 * `graph` its unfinished `dependsOn` siblings, under `ordered` the unfinished
 * pieces ahead of it in the queue, under `parallel` nothing.
 */
export function waitingOn(task: BoardCard, tasks: BoardCard[], runMode: BoardCard["runMode"]): BoardCard[] {
  if (task.status !== "todo") return [];
  const unfinished = (sibling: BoardCard) => sibling.status !== "done" && sibling.status !== "abandoned";
  if (runMode === "graph") {
    const deps = new Set(task.dependsOn ?? []);
    return tasks.filter((sibling) => deps.has(sibling.id) && unfinished(sibling));
  }
  if (runMode === "ordered") return tasks.filter((sibling) => sibling.position < task.position && unfinished(sibling));
  return [];
}
