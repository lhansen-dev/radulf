/**
 * Card export and import (roadmap item 6).
 *
 * What travels is the card as a piece of *intent*: its title and description,
 * the per-card settings the operator chose for it, and its scoping thread —
 * which spec 17 calls the durable record of why the card is shaped the way it
 * is, and which is the part nobody would reconstruct by hand.
 *
 * What does not travel is anything that happened. Runs, iterations,
 * transcripts, reviews and worktree paths describe one machine's execution and
 * mean nothing on another. Plans are left out for a sharper reason: a plan is
 * written against one checkout at one commit, so importing one would land a
 * card that claims to be planned for a repository the plan has never seen.
 * An imported card is planned where it arrives.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { cards, db, now, scopingMessages, type ScopingRole, SCOPING_ROLES } from "@/db";
import { ClientError } from "./clientError";
import { listBranches } from "./git";
import { emitEvent } from "./events";
import { requireCard } from "./cards";
import { requireRepo } from "./repos";
import { record } from "./requestValidation";

/**
 * The file format. Versioned because it is written to disk and read back by a
 * different install, possibly a different version of Radulf.
 */
export const CARD_EXPORT_VERSION = 1;

export type ExportedCard = {
  title: string;
  description: string;
  baseBranch: string | null;
  source: "user" | "agent";
  maxIterations: number | null;
  timeoutMinutes: number | null;
  reviewPlanBeforeImplementation: boolean;
  autoApprove: boolean;
  openPr: boolean;
  grillMe: boolean;
  scopingAuthorsPlan: boolean;
  plannerModel: string | null;
  loopModel: string | null;
  evaluatorModel: string | null;
  scoping: { role: ScopingRole; content: string }[];
};

export type CardExport = {
  version: number;
  exportedAt: string;
  /** The source repository's name, as a hint for whoever imports this. Not
   * binding: the importer names the repository the cards land in. */
  repoName: string;
  cards: ExportedCard[];
};

/** One card, or every card of a repository. */
export function exportCards(selector: { cardId?: string; repoId?: string }): CardExport {
  if (!selector.cardId && !selector.repoId) {
    throw new ClientError("either cardId or repoId is required");
  }
  const rows = selector.cardId
    ? [requireCard(selector.cardId)]
    : db
        .select()
        .from(cards)
        .where(eq(cards.repoId, selector.repoId!))
        .orderBy(asc(cards.createdAt))
        .all();
  if (rows.length === 0) throw new ClientError("that repository has no cards to export");
  const repo = requireRepo(rows[0].repoId);
  const threads = threadsFor(rows.map((row) => row.id));
  return {
    version: CARD_EXPORT_VERSION,
    exportedAt: now(),
    repoName: repo.name,
    cards: rows.map((row) => ({
      title: row.title,
      description: row.description,
      baseBranch: row.baseBranch,
      source: row.source,
      maxIterations: row.maxIterations,
      timeoutMinutes: row.timeoutMinutes,
      reviewPlanBeforeImplementation: Boolean(row.reviewPlanBeforeImplementation),
      autoApprove: Boolean(row.autoApprove),
      openPr: Boolean(row.openPr),
      grillMe: Boolean(row.grillMe),
      scopingAuthorsPlan: Boolean(row.scopingAuthorsPlan),
      plannerModel: row.plannerModel,
      loopModel: row.loopModel,
      evaluatorModel: row.evaluatorModel,
      scoping: threads.get(row.id) ?? [],
    })),
  };
}

function threadsFor(cardIds: string[]): Map<string, { role: ScopingRole; content: string }[]> {
  const out = new Map<string, { role: ScopingRole; content: string }[]>();
  if (cardIds.length === 0) return out;
  for (const row of db
    .select()
    .from(scopingMessages)
    .where(inArray(scopingMessages.cardId, cardIds))
    .orderBy(asc(scopingMessages.id))
    .all()) {
    const thread = out.get(row.cardId) ?? [];
    thread.push({ role: row.role, content: row.content });
    out.set(row.cardId, thread);
  }
  return out;
}

/** A filename a browser will not have to guess at. */
export function exportFileName(exported: CardExport): string {
  const slug = exported.repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cards";
  const stamp = exported.exportedAt.slice(0, 10);
  const count = exported.cards.length === 1 ? "card" : `${exported.cards.length}-cards`;
  return `radulf-${slug}-${count}-${stamp}.json`;
}

export type ImportResult = {
  cardIds: string[];
  /** Anything the import had to change to land, so it is never silent. */
  notes: string[];
};

/**
 * Create the exported cards in `repoId`, in Backlog.
 *
 * Always Backlog, never the Queue: importing a file must not start work. Ids
 * are always fresh, because an exported id may already exist here. A
 * `baseBranch` the target repository does not have falls back to the repo
 * default with a note, rather than failing an otherwise good import over a
 * branch name that only ever meant something on the machine it came from.
 */
export async function importCards(repoId: string, payload: unknown): Promise<ImportResult> {
  const repo = requireRepo(repoId);
  const parsed = parseCardExport(payload);
  const notes: string[] = [];
  const wanted = new Set(parsed.cards.map((card) => card.baseBranch).filter((name) => name !== null));
  // One listing for the whole file, however many cards name a branch.
  const present = wanted.size > 0 ? new Set(await listBranches(repo.path)) : new Set<string>();
  for (const name of wanted) {
    if (present.has(name)) continue;
    notes.push(`${repo.name} has no branch "${name}", so those cards use its default instead`);
  }
  const resolveBranch = (name: string | null) => (name && present.has(name) ? name : null);

  const cardIds = db.transaction((tx) =>
    parsed.cards.map((card) => {
      const id = nanoid();
      tx.insert(cards)
        .values({
          id,
          repoId,
          title: card.title,
          description: card.description,
          status: "backlog",
          position: 0,
          baseBranch: resolveBranch(card.baseBranch),
          source: card.source,
          maxIterations: card.maxIterations,
          timeoutMinutes: card.timeoutMinutes,
          reviewPlanBeforeImplementation: card.reviewPlanBeforeImplementation ? 1 : 0,
          autoApprove: card.autoApprove ? 1 : 0,
          openPr: card.openPr ? 1 : 0,
          grillMe: card.grillMe ? 1 : 0,
          scopingAuthorsPlan: card.scopingAuthorsPlan ? 1 : 0,
          plannerModel: card.plannerModel,
          loopModel: card.loopModel,
          evaluatorModel: card.evaluatorModel,
          createdAt: now(),
          updatedAt: now(),
        })
        .run();
      for (const message of card.scoping) {
        tx.insert(scopingMessages)
          .values({ cardId: id, role: message.role, content: message.content, createdAt: now() })
          .run();
      }
      return id;
    }),
  );
  emitEvent("cards.imported", { payload: { repoId, count: cardIds.length, from: parsed.repoName } });
  return { cardIds, notes };
}

const MAX_IMPORT_CARDS = 500;

/** Validate a file somebody else wrote. Every field is optional except the
 * title: an export from a newer Radulf may carry fields this one has never
 * heard of, and those are ignored rather than fatal. */
export function parseCardExport(value: unknown): CardExport {
  const body = record(value, "card export");
  if (Number(body.version) !== CARD_EXPORT_VERSION) {
    throw new ClientError(
      `this file says it is card export version ${String(body.version)}; this Radulf reads version ${CARD_EXPORT_VERSION}`,
    );
  }
  if (!Array.isArray(body.cards) || body.cards.length === 0) {
    throw new ClientError("that file holds no cards");
  }
  if (body.cards.length > MAX_IMPORT_CARDS) {
    throw new ClientError(`that file holds ${body.cards.length} cards, more than the ${MAX_IMPORT_CARDS} limit`);
  }
  return {
    version: CARD_EXPORT_VERSION,
    exportedAt: typeof body.exportedAt === "string" ? body.exportedAt : now(),
    repoName: typeof body.repoName === "string" ? body.repoName : "somewhere else",
    cards: body.cards.map((card, i) => parseExportedCard(card, i)),
  };
}

function parseExportedCard(value: unknown, index: number): ExportedCard {
  const card = record(value, `card ${index + 1}`);
  const title = typeof card.title === "string" ? card.title.trim() : "";
  if (!title) throw new ClientError(`card ${index + 1} has no title`);
  const cap = (key: string, max: number) => {
    const raw = card[key];
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
  };
  const text = (key: string) => (typeof card[key] === "string" && card[key] ? (card[key] as string) : null);
  return {
    title,
    description: typeof card.description === "string" ? card.description : "",
    baseBranch: text("baseBranch"),
    source: card.source === "agent" ? "agent" : "user",
    maxIterations: cap("maxIterations", 1_000),
    timeoutMinutes: cap("timeoutMinutes", 10_080),
    reviewPlanBeforeImplementation: Boolean(card.reviewPlanBeforeImplementation),
    autoApprove: Boolean(card.autoApprove),
    openPr: Boolean(card.openPr),
    grillMe: Boolean(card.grillMe),
    scopingAuthorsPlan: Boolean(card.scopingAuthorsPlan),
    plannerModel: text("plannerModel"),
    loopModel: text("loopModel"),
    evaluatorModel: text("evaluatorModel"),
    scoping: Array.isArray(card.scoping) ? card.scoping.flatMap(parseScopingMessage) : [],
  };
}

/** A message with an unknown role is dropped, not renamed: guessing which
 * speaker it was would put words in the planner's mouth. */
function parseScopingMessage(value: unknown): { role: ScopingRole; content: string }[] {
  if (typeof value !== "object" || value === null) return [];
  const { role, content } = value as { role?: unknown; content?: unknown };
  if (typeof content !== "string" || !content) return [];
  return SCOPING_ROLES.includes(role as ScopingRole) ? [{ role: role as ScopingRole, content }] : [];
}
