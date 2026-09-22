import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, now, scopingMessages, TRANSCRIPTS_DIR, type ScopingRole } from "@/db";
import { ClientError } from "./clientError";
import { requireCard as requireCardRow } from "./cards";
import { requireRepo } from "./repos";
import { runHarness } from "./harness";
import { normalizeProvider } from "./providers";
import { getSettings } from "./settings";

export type ScopingMessage = typeof scopingMessages.$inferSelect;

/**
 * One scoping turn is a read-only exploration of a real repository while the
 * operator waits, so this bounds a wedged provider without cutting off a
 * genuine look around. The stall watchdog still ends a dead stream early.
 */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

export function listScopingMessages(cardId: string): ScopingMessage[] {
  return db
    .select()
    .from(scopingMessages)
    .where(eq(scopingMessages.cardId, cardId))
    .orderBy(asc(scopingMessages.id))
    .all();
}

export function addScopingMessage(cardId: string, role: ScopingRole, content: string): ScopingMessage {
  return db
    .insert(scopingMessages)
    .values({ cardId, role, content, createdAt: now() })
    .returning()
    .get();
}

const SPEAKER: Record<ScopingRole, string> = {
  user: "Operator",
  assistant: "You",
  planner: "Planner",
  loop: "Implementation loop",
};

/** Default pacing: a few questions a turn, conversationally. */
const PACE_CONVERSATIONAL =
  "- Ask one to three high-value questions per turn, then stop and wait. Offer plausible " +
  "options when useful, recommend one, and say its tradeoff.";

/**
 * Grill-me pacing (upstream issue 33), following the `grilling` skill in
 * mattpocock/skills: a design tree worked in rounds, each round asking every
 * question whose prerequisites are settled, rather than a few questions a
 * turn. Opt-in per card via `cards.grillMe`, because what it buys is a much
 * longer conversation.
 */
const PACE_GRILLING = [
  "- Grill the operator. Map this card as a DESIGN TREE: every decision branches into the",
  "  decisions that hang off it. Work the tree in ROUNDS. The FRONTIER is every decision whose",
  "  prerequisites are already settled, so you can ask about it now without guessing at an",
  "  answer you have not heard yet. Ask the WHOLE frontier in one round, then stop and wait. A",
  "  question whose answer depends on another question still open in this round belongs to a",
  "  later round, not this one.",
  "- Number the questions and give each one your recommended answer. Format a round exactly",
  "  like this, with a `---` line between questions:",
  "",
  "  ❓ **Q1** - **<question title>**: <question body, which may include options>",
  "",
  "  ➡️ <your recommended answer>",
  "",
  "- Finding FACTS is your job, never the operator's: read the repository for anything you",
  "  could look up yourself. The DECISIONS are theirs, so put each one to them and wait.",
  "- Every answer reshapes the tree: settled decisions push the frontier outward and unblock",
  "  questions that depended on them. Recompute the frontier and ask the next round. You are",
  "  finished when the frontier is empty and nothing is left silently assumed. Say so then,",
  "  and offer to write the scoped card.",
].join("\n");

/**
 * The scoping session's prompt (spec 17). Each turn re-sends the whole thread
 * as one prompt: the session is a fresh read-only harness invocation against
 * the card's repository, so the thread in the database is the only memory.
 * `request` picks the tail — the next message to the operator, or the scoped
 * card the thread has been working towards. The card's `grillMe` flag picks
 * the pacing.
 */
export function renderScopingPrompt(
  card: { title: string; description: string; grillMe?: number },
  messages: Pick<ScopingMessage, "role" | "content">[],
  request: "reply" | "proposal",
): string {
  const thread = messages.length
    ? messages.map((m) => `${SPEAKER[m.role]}: ${m.content}`).join("\n\n")
    : "(nothing yet)";
  const tail = request === "reply"
    ? "Write your next message to the operator."
    : SCOPED_CARD_REQUEST;
  return [
    "You are the scoping assistant for Radulf, a board whose cards are coding tasks that " +
      "an autonomous planner, implementation loop, and evaluator carry out with no access " +
      "to this conversation. You are helping the operator sharpen ONE card before it is planned.",
    "You are in the card's repository (your current working directory) with read-only tools. " +
      "Ground every question and suggestion in what you find there: name real paths, existing " +
      "behaviour, and tests instead of asking the operator to locate them for you. Keep the " +
      "investigation proportional to the ask.",
    `THE CARD\n========\nTitle: ${card.title}\n\n${card.description || "(no description yet)"}`,
    "HOW TO WORK\n===========\n" +
      "- Interview until the work is clear: the problem and one concrete example of the desired " +
      "result, the smallest useful scope and what it excludes, observable acceptance criteria " +
      "with a feasible way to verify each, and the constraints that matter. Challenge vague words " +
      "such as \"better\", \"clean up\", or \"support X\" with concrete scenarios.\n" +
      `${card.grillMe ? PACE_GRILLING : PACE_CONVERSATIONAL}\n` +
      "- Ask about product decisions; leave ordinary implementation choices to the planner.\n" +
      "- Briefly reflect the settled decisions when they change. Never repeat an answered " +
      "question, and never treat silence as agreement.\n" +
      "- Messages from \"Planner\" are blocking questions the planning agent raised when it tried " +
      "to plan this card, and messages from \"Implementation loop\" are blockers the loop hit while " +
      "carrying it out. Make sure the operator's answers resolve them, and say so when they do.\n" +
      "- Reply in plain Markdown and keep it short. No preamble, no sign-off.",
    `THE CONVERSATION SO FAR\n=======================\n${thread}`,
    tail,
  ].join("\n\n");
}

const SCOPED_CARD_REQUEST =
  "Now write the scoped card. Output EXACTLY this format and nothing else:\n\n" +
  "TITLE: <one line, action-oriented, naming the behaviour and the area it touches>\n" +
  "DESCRIPTION:\n" +
  "<Markdown written for a fresh agent with no access to this conversation: include the " +
  "decisions, the example, and the evidence, with real repository paths. Use these sections, " +
  "omitting any that adds nothing:\n" +
  "## Problem\n## Desired behavior and scope\n## Acceptance criteria (a `- [ ]` checklist of " +
  "observable outcomes)\n## Constraints and dependencies\n## Code context\n## Verification>";

/**
 * Split a proposal reply into the card fields. Lenient on purpose: a model
 * that skips the TITLE line keeps the card's current title, one that skips the
 * DESCRIPTION marker has its whole reply taken as the description, and a
 * reply wrapped in one code fence is unwrapped.
 */
export function parseScopedCardProposal(
  text: string,
  fallbackTitle: string,
): { title: string; description: string } {
  let body = text.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(body);
  if (fenced) body = fenced[1].trim();
  const titleMatch = /^TITLE:[ \t]*(.+)$/m.exec(body);
  const title = titleMatch?.[1].trim() || fallbackTitle;
  const marker = /^DESCRIPTION:[ \t]*$/m.exec(body);
  const description = marker
    ? body.slice(marker.index + marker[0].length).trim()
    : body.replace(/^TITLE:.*$/m, "").trim();
  return { title, description };
}

function requireCard(cardId: string) {
  const card = requireCardRow(cardId);
  return { card, repo: requireRepo(card.repoId) };
}

/**
 * Cards with a scoping turn in flight. Scoping runs outside the pipeline
 * slots, so nothing else bounds it: every POST started another model session
 * against the repository for up to TURN_TIMEOUT_MS, however many were already
 * running for the same card. One turn per card at a time; the thread is
 * sequential anyway.
 */
const turnsInFlight = new Set<string>();

async function oneTurnAtATime<T>(cardId: string, turn: () => Promise<T>): Promise<T> {
  if (turnsInFlight.has(cardId)) {
    throw new ClientError("a scoping turn is already running for this card", 409);
  }
  turnsInFlight.add(cardId);
  try {
    return await turn();
  } finally {
    turnsInFlight.delete(cardId);
  }
}

/** One read-only harness turn against the card's repository, on the scoping role. */
async function ask(
  card: { id: string; title: string; description: string },
  repo: { path: string },
  messages: ScopingMessage[],
  request: "reply" | "proposal",
): Promise<string> {
  const settings = getSettings();
  const result = await runHarness({
    provider: normalizeProvider(settings.scopingProvider, "anthropic"),
    model: settings.scopingModel,
    reasoningLevel: settings.scopingReasoningLevel,
    prompt: renderScopingPrompt(card, messages, request),
    cwd: repo.path,
    transcriptPath: path.join(TRANSCRIPTS_DIR, `scoping-${card.id}-${nanoid()}.jsonl`),
    timeoutMs: TURN_TIMEOUT_MS,
    readOnly: true,
  });
  if (result.error) throw new Error(result.error);
  if (result.timedOut) throw new Error("the scoping session timed out");
  if (!result.lastText) throw new Error("the scoping session returned an empty reply");
  return result.lastText;
}

/**
 * Record the operator's message and, unless `reply` is false, the assistant's
 * answer to it. `reply: false` is for answering the planner's questions
 * without waiting on another turn — the answer still joins the thread the
 * planner reads on its next run.
 */
export async function scopingTurn(
  cardId: string,
  content: string,
  opts: { reply?: boolean } = {},
): Promise<ScopingMessage[]> {
  const text = content.trim();
  if (!text) throw new ClientError("content is required");
  const { card, repo } = requireCard(cardId);
  if (opts.reply === false) {
    addScopingMessage(cardId, "user", text);
    return listScopingMessages(cardId);
  }
  return oneTurnAtATime(cardId, async () => {
    addScopingMessage(cardId, "user", text);
    const reply = await ask(card, repo, listScopingMessages(cardId), "reply");
    addScopingMessage(cardId, "assistant", reply);
    return listScopingMessages(cardId);
  });
}

/**
 * The session's concrete output (spec 17): a rewritten title and description
 * for the operator to accept or edit. The proposal itself is kept in the
 * thread, so what was offered stays on record whether or not it was applied.
 */
export async function proposeScopedCard(
  cardId: string,
): Promise<{ title: string; description: string; messages: ScopingMessage[] }> {
  const { card, repo } = requireCard(cardId);
  return oneTurnAtATime(cardId, async () => {
    const raw = await ask(card, repo, listScopingMessages(cardId), "proposal");
    addScopingMessage(cardId, "assistant", raw);
    return { ...parseScopedCardProposal(raw, card.title), messages: listScopingMessages(cardId) };
  });
}
