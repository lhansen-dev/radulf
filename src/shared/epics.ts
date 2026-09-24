/** Spec 24: how an epic's pieces are scheduled. `ordered` holds each piece
 * until every sibling queued before it has finished; `parallel` lets the
 * repo's concurrency cap bound them; `graph` (spec 28) starts a piece once
 * every piece it depends on is done or abandoned. Shared so the editor and
 * the schema agree on the words. */
export const EPIC_RUN_MODES = ["ordered", "parallel", "graph"] as const;
export type EpicRunMode = (typeof EPIC_RUN_MODES)[number];
