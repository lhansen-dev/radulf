"use client";
import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../../ui/api";
import type { ScopingMessage } from "./useCardDetail";

/** Statuses in which the thread can still change what gets planned. */
const SCOPABLE = new Set(["backlog", "todo", "needs_attention"]);

type Busy = "send" | "answer" | "propose" | "apply" | null;

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
  messages,
  onChanged,
}: {
  cardId: string;
  status: string;
  messages: ScopingMessage[];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<{ title: string; description: string } | null>(null);
  const open = SCOPABLE.has(status);
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
      setError(e instanceof Error ? e.message : String(e));
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

  const waiting = busy === "send" || busy === "propose";
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

      {open && !proposal && (
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
            <button type="button" onClick={propose} disabled={busy !== null} className={`${buttonCls} ml-auto bg-foreground/10`}>
              {busy === "propose" ? "Writing…" : "Draft the scoped task"}
            </button>
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

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </section>
  );
}

/** Compact Markdown for a chat message: GFM, no raw HTML, list and code styling only. */
function Markdown({ children }: { children: string }) {
  return (
    <div className="flex flex-col gap-1.5 [&_code]:rounded [&_code]:bg-foreground/10 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }: ComponentPropsWithoutRef<"h1">) => <p className="font-semibold">{children as ReactNode}</p>,
          h2: ({ children }: ComponentPropsWithoutRef<"h2">) => <p className="font-semibold">{children as ReactNode}</p>,
          h3: ({ children }: ComponentPropsWithoutRef<"h3">) => <p className="font-medium">{children as ReactNode}</p>,
          ul: ({ children }: ComponentPropsWithoutRef<"ul">) => <ul className="list-disc space-y-0.5 pl-5">{children as ReactNode}</ul>,
          ol: ({ children }: ComponentPropsWithoutRef<"ol">) => <ol className="list-decimal space-y-0.5 pl-5">{children as ReactNode}</ol>,
          pre: ({ children }: ComponentPropsWithoutRef<"pre">) => <pre className="overflow-x-auto rounded bg-foreground/[0.06] p-2 text-xs [&_code]:bg-transparent [&_code]:p-0">{children as ReactNode}</pre>,
          a: ({ href, children }: ComponentPropsWithoutRef<"a">) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-amber-300 underline">{children as ReactNode}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
