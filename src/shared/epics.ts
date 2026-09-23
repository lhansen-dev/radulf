/** Spec 24: how an epic's pieces are scheduled. `ordered` holds each piece
 * until every sibling queued before it has finished; `parallel` lets the
 * repo's concurrency cap bound them. Shared so the editor and the schema
 * agree on the two words. */
export const EPIC_RUN_MODES = ["ordered", "parallel"] as const;
export type EpicRunMode = (typeof EPIC_RUN_MODES)[number];
