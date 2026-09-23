import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, now, scopingMessages, TRANSCRIPTS_DIR, type EpicRunMode, type ScopingRole } from "@/db";
import { ClientError } from "./clientError";
import { requireCard as requireCardRow } from "./cards";
import { emitEvent } from "./events";
import { requireRepo } from "./repos";
import { runHarness } from "./harness";
import { normalizeProvider } from "./providers";
import { getSettings } from "./settings";
import { startTranscriptPush } from "./transcript";
import { scopingRunId } from "@/shared/scopingRunId";

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
  request: ScopingRequest,
): string {
  const thread = messages.length
    ? messages.map((m) => `${SPEAKER[m.role]}: ${m.content}`).join("\n\n")
    : "(nothing yet)";
  const tail = REQUEST_TAIL[request];
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

/**
 * What the session is being asked for this turn. Spec 17: a session ends by
 * producing something concrete, and there are three concrete things it can
 * produce.
 */
export type ScopingRequest = "reply" | "proposal" | "split" | "plan";

const SCOPED_CARD_REQUEST =
  "Now write the scoped card. Output EXACTLY this format and nothing else:\n\n" +
  "TITLE: <one line, action-oriented, naming the behaviour and the area it touches>\n" +
  "DESCRIPTION:\n" +
  "<Markdown written for a fresh agent with no access to this conversation: include the " +
  "decisions, the example, and the evidence, with real repository paths. Use these sections, " +
  "omitting any that adds nothing:\n" +
  "## Problem\n## Desired behavior and scope\n## Acceptance criteria (a `- [ ]` checklist of " +
  "observable outcomes)\n## Constraints and dependencies\n## Code context\n## Verification>";

const SPLIT_REQUEST =
  "This ask has turned out to be more than one piece of work, so split it. Output two or more " +
  "cards in the order they should be done, each piece independently useful and independently " +
  "reviewable, and each one small enough for a single agent to carry out. Do not split work " +
  "that only makes sense together, and do not invent scope the conversation did not settle. " +
  "Output EXACTLY this format and nothing else: one RUN line, then one block per card:\n\n" +
  "RUN: <`in order` when a later card builds on an earlier one, `in parallel` when every card " +
  "stands alone and they could all be worked at once>\n\n" +
  "CARD 1\n" +
  "TITLE: <one line, action-oriented>\n" +
  "DESCRIPTION:\n" +
  "<the same Markdown sections a single scoped card would carry, written for a fresh agent " +
  "with no access to this conversation. Say explicitly what this card does NOT do and which " +
  "earlier card it depends on.>\n\n" +
  "CARD 2\n" +
  "TITLE: ...\n" +
  "DESCRIPTION:\n" +
  "...";

const PLAN_REQUEST =
  "Now write this card's plan artifacts directly, skipping the planning agent. Output EXACTLY " +
  "three fenced blocks in this order and nothing else:\n\n" +
  "```PLAN.md\n" +
  "# <card title>\n\n## Tasks\n\n- [ ] <one task per checklist line, in order, each a single " +
  "agent iteration's worth of work and each verifiable on its own>\n" +
  "```\n\n" +
  "```PROMPT.md\n" +
  "<the standing brief every iteration is given: what the repository is, the conventions and " +
  "commands that matter here, and how to verify the work. Real paths from this repository. " +
  "This is the ONLY one of the three the implementation agent ever sees.>\n" +
  "```\n\n" +
  "```CRITERIA.md\n" +
  "<a `- [ ]` checklist of observable acceptance criteria, each with the command or the " +
  "observation that settles it>\n" +
  "```";

const REQUEST_TAIL: Record<ScopingRequest, string> = {
  reply: "Write your next message to the operator.",
  proposal: SCOPED_CARD_REQUEST,
  split: SPLIT_REQUEST,
  plan: PLAN_REQUEST,
};

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

/** One card of a split proposal, in the order the session put it. */
export type SplitCard = { title: string; description: string };

/**
 * Split a split proposal into its cards.
 *
 * `CARD <n>` on a line of its own is the separator; anything before the first
 * one is preamble the model was asked not to write, and is dropped. So is an
 * empty block, which a trailing separator or a skipped number leaves behind.
 * Each surviving block is read exactly as a single scoped card is, so a block
 * that omits its TITLE line still yields a usable card, numbered after the
 * original. The operator edits the result before it is applied, and applying
 * refuses a card with no title.
 */
export function parseSplitProposal(text: string, fallbackTitle: string): SplitCard[] {
  let body = text.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(body);
  if (fenced) body = fenced[1].trim();
  return body
    .split(/^CARD\s+\d+\s*$/m)
    .slice(1)
    .filter((block) => block.trim())
    .map((block, i) => parseScopedCardProposal(block, `${fallbackTitle} (${i + 1})`));
}

/**
 * Spec 24: the run mode a split proposal recommends for its pieces. In order
 * unless the reply says in parallel, because in order is what the queue did
 * before the line existed, and a missing line should not loosen that.
 */
export function parseSplitRunMode(text: string): EpicRunMode {
  return /^RUN:.*\bparallel\b/im.test(text) ? "parallel" : "ordered";
}

/** The three artifacts a planning run would have produced. */
export type PlanArtifacts = { planMd: string; promptMd: string; acceptanceCriteria: string };

/**
 * Pull PLAN.md, PROMPT.md and CRITERIA.md out of a plan reply.
 *
 * Keyed on the filename rather than on position, because a model that
 * reorders the blocks or labels the fence `markdown` is far likelier than one
 * that renames the files. Returns null when any of the three is missing:
 * there is no fallback prompt, so a partial answer cannot run.
 */
export function parsePlanProposal(text: string): PlanArtifacts | null {
  const blocks = new Map<string, string>();
  const fence = /```[ \t]*([A-Za-z0-9_.-]*)[ \t]*\n([\s\S]*?)```/g;
  for (const [, label, content] of text.matchAll(fence)) {
    const name = /^(PLAN|PROMPT|CRITERIA)\.md$/i.exec(label.trim())?.[1].toUpperCase();
    if (name && !blocks.has(name)) blocks.set(name, content.trimEnd());
  }
  const plan = blocks.get("PLAN");
  const prompt = blocks.get("PROMPT");
  const criteria = blocks.get("CRITERIA");
  if (!plan?.trim() || !prompt?.trim() || !criteria?.trim()) return null;
  return { planMd: plan, promptMd: prompt, acceptanceCriteria: criteria };
}

function requireCard(cardId: string) {
  const card = requireCardRow(cardId);
  return { card, repo: requireRepo(card.repoId) };
}

/** A scoping turn in flight: what it was asked for, and since when. */
export type ScopingTurnInFlight = { request: ScopingRequest; startedAt: string };

/**
 * Cards with a scoping turn in flight. Scoping runs outside the pipeline
 * slots, so nothing else bounds it: every POST started another model session
 * against the repository for up to TURN_TIMEOUT_MS, however many were already
 * running for the same card. One turn per card at a time; the thread is
 * sequential anyway. The entry is also how the card page learns a turn is
 * running when it was not the one to start it: after a reload, or in a
 * second tab.
 */
const turnsInFlight = new Map<string, ScopingTurnInFlight>();

export function scopingTurnInFlight(cardId: string): ScopingTurnInFlight | null {
  return turnsInFlight.get(cardId) ?? null;
}

async function oneTurnAtATime<T>(
  cardId: string,
  request: ScopingRequest,
  turn: () => Promise<T>,
): Promise<T> {
  if (turnsInFlight.has(cardId)) {
    throw new ClientError("a scoping turn is already running for this card", 409);
  }
  turnsInFlight.set(cardId, { request, startedAt: now() });
  // Both events refresh the card page: the start so a second tab sees the
  // turn running, the finish so the reply lands without a manual reload.
  emitEvent("scoping.started", { cardId, payload: { request } });
  try {
    return await turn();
  } finally {
    turnsInFlight.delete(cardId);
    emitEvent("scoping.finished", { cardId, payload: { request } });
  }
}

/** One read-only harness turn against the card's repository, on the scoping role. */
async function ask(
  card: { id: string; title: string; description: string },
  repo: { path: string },
  messages: ScopingMessage[],
  request: ScopingRequest,
): Promise<string> {
  const settings = getSettings();
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `scoping-${card.id}-${nanoid()}.jsonl`);
  // Pushed live under the card's scoping run id, so the panel can say what
  // the session is reading while the operator waits on the turn.
  const stop = startTranscriptPush(transcriptPath, scopingRunId(card.id), 0);
  let result: Awaited<ReturnType<typeof runHarness>>;
  try {
    result = await runHarness({
      provider: normalizeProvider(settings.scopingProvider, "anthropic"),
      model: settings.scopingModel,
      reasoningLevel: settings.scopingReasoningLevel,
      prompt: renderScopingPrompt(card, messages, request),
      cwd: repo.path,
      transcriptPath,
      timeoutMs: TURN_TIMEOUT_MS,
      readOnly: true,
    });
  } finally {
    stop();
  }
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
  return oneTurnAtATime(cardId, "reply", async () => {
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
  return oneTurnAtATime(cardId, "proposal", async () => {
    const raw = await ask(card, repo, listScopingMessages(cardId), "proposal");
    addScopingMessage(cardId, "assistant", raw);
    return { ...parseScopedCardProposal(raw, card.title), messages: listScopingMessages(cardId) };
  });
}

/**
 * The session's second concrete output (spec 17): the work turned out to be
 * more than one card, so here are the pieces in order, with the run mode the
 * session recommends for them (spec 24). A proposal and nothing more —
 * applying it is a separate, operator-driven step, the same posture decision
 * 6 takes on merging. The reply joins the thread either way.
 */
export async function proposeSplit(
  cardId: string,
): Promise<{ cards: SplitCard[]; runMode: EpicRunMode; messages: ScopingMessage[] }> {
  const { card, repo } = requireCard(cardId);
  return oneTurnAtATime(cardId, "split", async () => {
    const raw = await ask(card, repo, listScopingMessages(cardId), "split");
    addScopingMessage(cardId, "assistant", raw);
    const split = parseSplitProposal(raw, card.title);
    if (split.length < 2) {
      throw new ClientError(
        "the session did not come back with two or more cards — its reply is in the thread",
      );
    }
    return { cards: split, runMode: parseSplitRunMode(raw), messages: listScopingMessages(cardId) };
  });
}

/**
 * The session's third concrete output (spec 17): the plan artifacts
 * themselves, skipping the planning stage. Opt-in per card, so this refuses a
 * card that has not asked for it rather than quietly bypassing the planner.
 * Returns the artifacts; persisting them and moving the card is the
 * orchestrator's job, since that is where plan rows and card status live.
 */
export async function proposeScopedPlan(
  cardId: string,
): Promise<PlanArtifacts & { messages: ScopingMessage[] }> {
  const { card, repo } = requireCard(cardId);
  if (!card.scopingAuthorsPlan) {
    throw new ClientError("this card does not let its scoping session write the plan");
  }
  return oneTurnAtATime(cardId, "plan", async () => {
    const raw = await ask(card, repo, listScopingMessages(cardId), "plan");
    addScopingMessage(cardId, "assistant", raw);
    const artifacts = parsePlanProposal(raw);
    if (!artifacts) {
      throw new ClientError(
        "the session did not come back with all three plan artifacts — its reply is in the thread",
      );
    }
    return { ...artifacts, messages: listScopingMessages(cardId) };
  });
}
