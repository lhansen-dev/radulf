import type { BoardCard } from "./api";

/**
 * Whether a card matches what the operator typed into the Work feed's search.
 *
 * Title and description only: the repository has its own scope picker beside
 * the box, and status is what the view tabs already select, so matching on
 * either would make a search narrower than the control the operator just used.
 * A blank or whitespace-only query matches everything, which is what makes
 * clearing the box the same thing as not having searched.
 */
export function cardMatches(
  card: Pick<BoardCard, "title" | "description">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    card.title.toLowerCase().includes(needle) ||
    card.description.toLowerCase().includes(needle)
  );
}
