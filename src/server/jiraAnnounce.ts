import { errorMessage } from "@/shared/errorMessage";
import { emitEvent } from "./events";
import { jiraAuthorization, restRoot } from "./jira";
import { getSettings } from "./settings";

/**
 * The one write Radulf makes to Jira: a single plain-text comment on the issue
 * a finished card came from, so the ticket says the work landed and where to
 * read about it. Opt-in (`jiraCommentOnDone`, off by default) and fire-and-forget:
 * the card is already Done, and nothing here may block, fail or retry that.
 *
 * Credentials and the REST root come from jira.ts, which stays the only place
 * that knows how to talk to Jira. Like the GitHub delivery, this runs host-side
 * so the sandboxed agents never hold the token — and they get no path here.
 */

/** How the card finished, which is the only thing the comment can usefully say.
 * `pr` carries a null url when the push happened but `gh pr create` did not
 * return a link; `epic` is the parent card of an epic whose every task finished,
 * where there is no single diff to point at. */
export type DoneOutcome =
  | { kind: "merge"; baseBranch: string; mergeCommit: string }
  | { kind: "pr"; prUrl: string | null }
  | { kind: "epic" };

/** Fallback when the operator has not told Radulf its own address. A comment
 * with a bare id in it is useless to a reader, but honest: it is the id the
 * card has, and it is not invented. */
function publicCardUrl(cardId: string): string {
  const base = process.env.RADULF_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}/card/${cardId}` : cardId;
}

/**
 * The comment body. Deliberately one sentence and a link, in Jira wiki markup
 * with no markup in it: Jira renders bare text, a Markdown link would show its
 * brackets, and a wall of Radulf's prose on someone else's ticket is worse than
 * nothing.
 */
export function doneCommentBody(card: { id: string; title: string }, outcome: DoneOutcome): string {
  let outcomeLine: string;
  if (outcome.kind === "merge") {
    outcomeLine = `merged into ${outcome.baseBranch} at ${outcome.mergeCommit.slice(0, 7)}`;
  } else if (outcome.kind === "pr") {
    outcomeLine = outcome.prUrl ? `opened pull request ${outcome.prUrl}` : "pushed as a pull request";
  } else {
    outcomeLine = "every task in the epic finished";
  }
  return `Radulf finished "${card.title}": ${outcomeLine}.\nCard: ${publicCardUrl(card.id)}`;
}

/** An event is the audit trail for a write nobody asked to be told about. It
 * must never be the thing that breaks a card: a failing insert — a closed db
 * during shutdown — is logged and dropped. */
function safeEmit(type: string, opts: { cardId: string; payload: Record<string, unknown> }): void {
  try {
    emitEvent(type, opts);
  } catch (e) {
    console.error("[radulf] jira event failed:", errorMessage(e));
  }
}

/**
 * Post the Done comment. Never throws and never retries: one attempt, and
 * every failure — network, timeout, a 401, the settings read itself — lands as
 * a `jira.comment_failed` event. Exactly one attempt matters: a retry on a
 * 500 would put a second identical comment on a human's ticket.
 *
 * `opts.timeoutMs` lets a caller that is already on a deadline (the delivery
 * path) cap the wait below the configured value. RADULF_JIRA_COMMENT_TIMEOUT_MS
 * is the operator's own knob for sites that are slow to answer.
 */
export async function announceCardDone(
  card: { id: string; title: string; jiraKey: string | null },
  outcome: DoneOutcome,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  try {
    const settings = getSettings();
    if (!settings.jiraCommentOnDone || !settings.jiraBaseUrl.trim() || !card.jiraKey) return;
    const requested = opts.timeoutMs ?? (Number(process.env.RADULF_JIRA_COMMENT_TIMEOUT_MS) || 10_000);
    const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : 10_000;
    const root = await restRoot(settings);
    const res = await fetch(`${root}/rest/api/2/issue/${encodeURIComponent(card.jiraKey)}/comment`, {
      method: "POST",
      headers: {
        Authorization: jiraAuthorization(settings),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: doneCommentBody(card, outcome) }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (res.ok) {
      safeEmit("jira.commented", { cardId: card.id, payload: { key: card.jiraKey, status: res.status } });
    } else {
      safeEmit("jira.comment_failed", {
        cardId: card.id,
        payload: { key: card.jiraKey, status: res.status, reason: `Jira responded ${res.status}` },
      });
    }
  } catch (e) {
    // Never the headers or the body: this message reaches an event row that the
    // browser renders, and the request carried the API token.
    safeEmit("jira.comment_failed", { cardId: card.id, payload: { key: card.jiraKey, reason: errorMessage(e) } });
  }
}