import { eq } from "drizzle-orm";
import { db, cards } from "@/db";
import { ClientError } from "./clientError";

export type Card = typeof cards.$inferSelect;

export function getCard(cardId: string): Card | undefined {
  return db.select().from(cards).where(eq(cards.id, cardId)).get();
}

/** The card row, or the 404 the API layer returns verbatim. */
export function requireCard(cardId: string): Card {
  const card = getCard(cardId);
  if (!card) throw new ClientError("card not found", 404);
  return card;
}
