/**
 * The run id a card's scoping turns push their live transcript under. Spec 17
 * gives scoping no run row, so this stands in for one on the event stream's
 * transcript channel (TranscriptPush in src/server/events.ts). Shared so the
 * scoping panel subscribes to exactly the pushes its own card's turn writes.
 */
export function scopingRunId(cardId: string): string {
  return `scoping:${cardId}`;
}
