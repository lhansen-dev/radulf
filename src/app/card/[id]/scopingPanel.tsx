"use client";
import { useState } from "react";
import { api } from "../../ui/api";
import { Markdown } from "../../ui/markdown";
import type { ScopingMessage } from "./useCardDetail";
import { SCOPABLE_STATUSES } from "@/shared/cardStatus";
import { errorMessage } from "@/shared/errorMessage";

type SplitCard = { title: string; description: string };

type Busy = "send" | "answer" | "propose" | "apply" | "split" | "plan" | null;

/**
 * The card's scoping thread (spec 17): the operator, an assistant that reads
 * this repository, and any blocking questions the planner raised. The thread
 * is stored on the card and handed to the planner whole, so nothing here has
 * to be copied into the description by hand — the assistant can write the
 * scoped task itself, for the operator to edit and apply.
 */
export function ScopingPanel({
  cardId,
  status,
  scopingAuthorsPlan = false,
  messages,
  onChanged,
}: {
  cardId: string;
  status: string;
  /** The card let its session write the plan itself (spec 17). */
  scopingAuthorsPlan?: boolean;
  messages: ScopingMessage[];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<{ title: string; description: string } | null>(null);
  const [split, setSplit] = useState<SplitCard[] | null>(null);
  const [notice, setNotice] = useState("");
  const open = SCOPABLE_STATUSES.includes(status as never);
  // The planner asked, or the loop stopped on a blocker: either way an answer
  // here is what "plan again" re-plans from.
  const awaitingAnswer = status === "needs_attention" && messages.some((m) => m.role === "planner" || m.role === "loop");
  const loopBlocked = awaitingAnswer && messages.at(-1)?.role === "loop";
  if (!open && messages.length === 0) return null;

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<void>) {
    setBusy(kind);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const send = () => run("send", async () => {
    const content = draft.trim();
    if (!content) return;
    await api(`/api/cards/${cardId}/scoping`, { json: { content } });
    setDraft("");
    onChanged();
  });
  // Answering the planner needs no assistant turn: the answer joins the
  // thread the planner reads, and planning starts again straight away.
  const answerAndPlan = () => run("answer", async () => {
    const content = draft.trim();
    if (!content) return;
    await api(`/api/cards/${cardId}/scoping`, { json: { content, reply: false } });
    await api(`/api/cards/${cardId}/restart`, { json: {} });
    setDraft("");
    onChanged();
  });
  const propose = () => run("propose", async () => {
    const result = await api<{ title: string; description: string }>(`/api/cards/${cardId}/scoping/proposal`, { json: {} });
    setProposal({ title: result.title, description: result.description });
    onChanged();
  });
  const apply = () => run("apply", async () => {
    if (!proposal) return;
    await api(`/api/cards/${cardId}`, { method: "PATCH", json: { title: proposal.title, description: proposal.description } });
    setProposal(null);
    onChanged();
  });
  // Spec 17: a split is a proposal, never an action — proposeSplit only
  // returns the pieces, and applySplit is this second, separate click.
  const proposeSplitCards = () => run("split", async () => {
    const result = await api<{ cards: SplitCard[] }>(`/api/cards/${cardId}/scoping/split`, { json: {} });
    setSplit(result.cards);
    onChanged();
  });
  const applySplit = () => run("apply", async () => {
    if (!split) return;
    await api(`/api/cards/${cardId}/scoping/split`, { json: { cards: split } });
    setSplit(null);
    setNotice(`Queued as ${split.length} cards, in order. This card is the first.`);
    onChanged();
  });
  const writePlan = () => run("plan", async () => {
    const result = await api<{ version: number; status: string }>(`/api/cards/${cardId}/scoping/plan`, { json: {} });
    setNotice(
      result.status === "plan_review"
        ? `Plan v${result.version} written and waiting for your review.`
        : `Plan v${result.version} written — the card is ready to run.`,
    );
    onChanged();
  });

  const waiting = busy === "send" || busy === "propose" || busy === "split" || busy === "plan";
  const fieldCls = "w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm";
  const buttonCls = "min-h-11 rounded-lg px-3 text-sm disabled:opacity-40";

  return (
    <section aria-labelledby="scoping-title" className="flex flex-col gap-3 rounded-lg border border-foreground/10 p-3">
      <div>
        <h3 id="scoping-title" className="text-sm font-medium">Scoping</h3>
        <p className="mt-0.5 text-xs text-foreground/50">
          Talk the task through with an assistant that reads this repository. The planner sees the whole thread
          {open ? ", and the assistant can write the scoped task for you." : "."}
        </p>
      </div>

      {messages.length > 0 && (
        <ol aria-label="Scoping thread" className="flex flex-col gap-2">
          {messages.map((m) => (
            <li
              key={m.id}
              className={`rounded-lg p-2.5 text-sm ${
                m.role === "user"
                  ? "ml-6 bg-amber-500/10"
                  : m.role === "planner" || m.role === "loop"
                    ? "mr-6 border border-amber-700/40 bg-amber-950/20"
                    : "mr-6 bg-foreground/[0.05]"
              }`}
            >
              {m.role !== "user" && (
                <p className={`mb-1 text-[11px] font-medium uppercase tracking-wide ${m.role === "assistant" ? "text-foreground/45" : "text-amber-300"}`}>
                  {m.role === "planner" ? "Planner asked" : m.role === "loop" ? "Loop blocked" : "Scoping assistant"}
                </p>
              )}
              {m.role === "user" ? <p className="whitespace-pre-wrap">{m.content}</p> : <Markdown>{m.content}</Markdown>}
            </li>
          ))}
        </ol>
      )}

      {open && !proposal && !split && (
        <>
          <textarea
            aria-label="Your message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
            rows={3}
            disabled={busy !== null}
            placeholder={
              loopBlocked
                ? "Say what the loop was missing, or what to do instead…"
                : awaitingAnswer
                ? "Answer the planner's questions…"
                : messages.length
                  ? "Reply…"
                  : "Describe the change you want, or ask what it would touch…"
            }
            className={fieldCls}
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={send} disabled={busy !== null || !draft.trim()} className={`${buttonCls} bg-foreground/10`}>
              {busy === "send" ? "Thinking…" : "Send"}
            </button>
            {awaitingAnswer && (
              <button type="button" onClick={answerAndPlan} disabled={busy !== null || !draft.trim()} className={`${buttonCls} bg-amber-600 font-medium text-on-accent`}>
                {busy === "answer" ? "Planning…" : "Answer and plan again"}
              </button>
            )}
            <button type="button" onClick={proposeSplitCards} disabled={busy !== null} className={`${buttonCls} ml-auto bg-foreground/10`}>
              {busy === "split" ? "Splitting…" : "Propose a split"}
            </button>
            <button type="button" onClick={propose} disabled={busy !== null} className={`${buttonCls} bg-foreground/10`}>
              {busy === "propose" ? "Writing…" : "Draft the scoped task"}
            </button>
            {scopingAuthorsPlan && (
              <button type="button" onClick={writePlan} disabled={busy !== null} className={`${buttonCls} bg-cyan-800/40 font-medium text-cyan-100`}>
                {busy === "plan" ? "Planning…" : "Write the plan"}
              </button>
            )}
          </div>
          {waiting && <p role="status" className="text-xs text-foreground/50">Reading the repository — this can take a minute.</p>}
        </>
      )}

      {proposal && (
        <div className="flex flex-col gap-2 rounded-lg border border-cyan-800/40 bg-cyan-950/20 p-3">
          <p className="text-sm font-medium text-cyan-300">Proposed task — edit anything, then apply</p>
          <label className="block text-xs text-foreground/70">
            Title
            <input value={proposal.title} onChange={(e) => setProposal({ ...proposal, title: e.target.value })} className={`mt-1 ${fieldCls}`} />
          </label>
          <label className="block text-xs text-foreground/70">
            Description
            <textarea value={proposal.description} onChange={(e) => setProposal({ ...proposal, description: e.target.value })} rows={14} className={`mt-1 font-mono ${fieldCls}`} />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setProposal(null)} disabled={busy !== null} className={`${buttonCls} text-foreground/60`}>Discard</button>
            <button type="button" onClick={apply} disabled={busy !== null || !proposal.title.trim()} className={`${buttonCls} bg-amber-600 font-medium text-on-accent`}>
              {busy === "apply" ? "Saving…" : "Apply to task"}
            </button>
          </div>
        </div>
      )}

      {split && (
        <div className="flex flex-col gap-3 rounded-lg border border-cyan-800/40 bg-cyan-950/20 p-3">
          <p className="text-sm font-medium text-cyan-300">
            Proposed split into {split.length} cards — edit anything, then apply
          </p>
          <p className="text-xs text-foreground/55">
            Applying queues them in this order. This card becomes the first one and keeps the
            thread; the rest are new cards with its settings.
          </p>
          {split.map((item, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] p-2.5">
              <label className="block text-xs text-foreground/70">
                {i + 1}. Title
                <input
                  value={item.title}
                  onChange={(e) => setSplit(split.map((c, j) => (j === i ? { ...c, title: e.target.value } : c)))}
                  className={`mt-1 ${fieldCls}`}
                />
              </label>
              <label className="block text-xs text-foreground/70">
                Description
                <textarea
                  value={item.description}
                  onChange={(e) => setSplit(split.map((c, j) => (j === i ? { ...c, description: e.target.value } : c)))}
                  rows={8}
                  className={`mt-1 font-mono ${fieldCls}`}
                />
              </label>
              {split.length > 2 && (
                <button
                  type="button"
                  onClick={() => setSplit(split.filter((_, j) => j !== i))}
                  disabled={busy !== null}
                  className="self-end text-xs text-foreground/50 hover:text-red-300"
                >
                  Drop this card
                </button>
              )}
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setSplit(null)} disabled={busy !== null} className={`${buttonCls} text-foreground/60`}>Discard</button>
            <button
              type="button"
              onClick={applySplit}
              disabled={busy !== null || split.some((c) => !c.title.trim())}
              className={`${buttonCls} bg-amber-600 font-medium text-on-accent`}
            >
              {busy === "apply" ? "Queueing…" : `Queue ${split.length} cards`}
            </button>
          </div>
        </div>
      )}

      {notice && <p role="status" className="text-sm text-cyan-300">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </section>
  );
}
