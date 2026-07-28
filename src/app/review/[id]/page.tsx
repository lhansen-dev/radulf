"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "../../ui/api";
import { parseEvaluation } from "@/shared/evaluation";
import { plannerModelTag, PlanModelBadge } from "../../ui/planModelBadge";
import { classifySelfModifying } from "./selfModifying";
import { classifySensitivePaths, changedIgnoreFiles } from "./sensitivePaths";
import { segmentSuspiciousChars } from "@/shared/diffSafety";
import { DoneSummaryView } from "./doneSummaryView";

type Detail = {
  card: { id: string; title: string; status: string };
  plans: { version: number; planMd: string; acceptanceCriteria: string }[];
  runs: {
    id: string;
    kind: string;
    status: string;
    iterationsDone: number;
    startedAt: string;
    endedAt: string | null;
    iterations: { n: number; summary: string | null }[];
    provider: string | null;
    model: string | null;
  }[];
};
type DiffPayload = { runId: string; branch: string; diff: string; stat: string; done: string | null; evaluation: string | null };

type DiffFile = { header: string; lines: string[] };

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { header: line.replace(/^diff --git a\/(.*) b\/.*$/, "$1"), lines: [] };
      files.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return files;
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-foreground/40";
  if (line.startsWith("@@")) return "text-sky-400/80";
  if (line.startsWith("+")) return "text-green-400 bg-green-950/40";
  if (line.startsWith("-")) return "text-red-400 bg-red-950/40";
  if (line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file"))
    return "text-foreground/40";
  return "text-foreground/70";
}

/** Render a diff line with any bidi-override/zero-width/tag/confusable
 * character shown as a visible, labeled escape instead of silently doing
 * whatever it does to the surrounding text's display order. */
function renderDiffLineContent(line: string) {
  if (!line) return " ";
  const segments = segmentSuspiciousChars(line);
  if (segments.length === 1 && segments[0].kind === "text") return segments[0].value;
  return segments.map((seg, i) =>
    seg.kind === "text" ? (
      <span key={i}>{seg.value}</span>
    ) : (
      <span key={i} title={seg.label} className="rounded bg-red-600/80 px-0.5 text-white">
        {`⟦${seg.label}⟧`}
      </span>
    ),
  );
}

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>()!;
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const rejectRef = useRef<HTMLDivElement>(null);

  const refetch = useCallback(() => {
    api<Detail>(`/api/cards/${id}`).then(setDetail).catch((e) => setError(String(e)));
    api<DiffPayload>(`/api/cards/${id}/diff`).then(setDiff).catch((e) => setError(String(e)));
  }, [id]);
  useEffect(refetch, [refetch]);

  const files = useMemo(() => (diff ? parseDiff(diff.diff) : []), [diff]);
  const evaluation = useMemo(() => (diff?.evaluation ? parseEvaluation(diff.evaluation) : null), [diff]);
  const flags = useMemo(() => classifySelfModifying(files.map((f) => f.header)), [files]);
  const sensitiveFlags = useMemo(() => classifySensitivePaths(files.map((f) => f.header)), [files]);
  const ignoreFilesChanged = useMemo(() => changedIgnoreFiles(files.map((f) => f.header)), [files]);
  const hasSuspiciousChars = useMemo(
    () => files.some((f) => f.lines.some((line) => segmentSuspiciousChars(line).length > 1)),
    [files],
  );
  const loopRun = detail?.runs.find((r) => r.kind === "loop" && r.status === "completed");
  const plan = detail?.plans[0];
  const planTag = detail ? plannerModelTag(detail.runs) : null;
  const wallTime =
    loopRun?.endedAt && loopRun.startedAt
      ? Math.round((new Date(loopRun.endedAt).getTime() - new Date(loopRun.startedAt).getTime()) / 60000)
      : null;

  async function decide(decision: "approved" | "rejected") {
    if (!loopRun) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/reviews", { json: { runId: loopRun.id, decision, feedback } });
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!rejecting) return;
    const previous = document.activeElement as HTMLElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    rejectRef.current?.querySelector<HTMLElement>("textarea")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setRejecting(false);
      if (event.key !== "Tab") return;
      const items = Array.from(rejectRef.current?.querySelectorAll<HTMLElement>('textarea, button:not([disabled])') ?? []);
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [rejecting, busy]);

  if (!detail) return <div className="p-8 text-foreground/50">{error || "Loading…"}</div>;

  return (
    <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-4 overflow-x-hidden p-4 pb-28 sm:p-6 sm:pb-28">
      <header className="flex min-w-0 items-center gap-3">
        <Link href="/" className="touch-target flex shrink-0 items-center text-sm text-foreground/50 hover:text-foreground">
          ← Work
        </Link>
        <h1 tabIndex={-1} className="min-w-0 grow truncate text-lg font-semibold">Review: {detail.card.title}</h1>
        <details className="relative">
          <summary className="grid size-11 cursor-pointer list-none place-items-center rounded-lg bg-foreground/[0.06] text-foreground/60" aria-label="Review options">•••</summary>
          <div className="absolute right-0 z-30 mt-2 w-56 rounded-xl border border-foreground/10 bg-surface p-1.5 shadow-xl">
            <Link href={`/card/${id}`} className="flex min-h-11 items-center rounded-lg px-3 text-sm hover:bg-foreground/[0.06]">Open task details</Link>
            <button disabled={busy} onClick={() => confirm("Abandon this task? Its worktree and branch will be deleted.") && api(`/api/cards/${id}/abandon`, { json: {} }).then(() => router.push("/"))} className="min-h-11 w-full rounded-lg px-3 text-left text-sm text-red-300 hover:bg-red-500/10">Abandon task</button>
          </div>
        </details>
      </header>

      {diff?.done && <DoneSummaryView done={diff.done} />}
      {evaluation && (
        <div className={`rounded border p-3 text-sm ${evaluation.verdict === "approve" ? "border-green-800/50 bg-green-950/30" : "border-amber-800/50 bg-amber-950/40"}`}>
          <span className={`font-medium ${evaluation.verdict === "approve" ? "text-green-300" : "text-amber-300"}`}>
            {evaluation.verdict === "approve"
              ? "🔎 Evaluator approved this change"
              : "🔎 Evaluator wanted more revisions — escalated to you after the revision limit"}
          </span>
          {evaluation.feedback && (
            <p className="mt-1 whitespace-pre-wrap text-foreground/80">{evaluation.feedback}</p>
          )}
        </div>
      )}
      {sensitiveFlags.length > 0 && (
        <div className="bg-red-950/40 border border-red-800/50 rounded p-3 text-sm">
          <span className="font-medium text-red-300">🛑 Touches sandbox / security-critical code</span>
          <div className="mt-1 space-y-1">
            {sensitiveFlags.map((flag) => (
              <div key={flag.label} className="text-foreground/80">
                <span className="text-red-400 font-medium">{flag.label}</span>
                {flag.paths.length > 0 && (
                  <span className="text-foreground/50 ml-1">({flag.paths.join(", ")})</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {ignoreFilesChanged.length > 0 && (
        <div className="bg-red-950/40 border border-red-800/50 rounded p-3 text-sm">
          <span className="font-medium text-red-300">🛑 .gitignore / .gitattributes changed</span>
          <p className="mt-1 text-foreground/80">
            These files can hide content from <code>git add</code> or from how a diff renders:{" "}
            {ignoreFilesChanged.join(", ")}
          </p>
        </div>
      )}
      {hasSuspiciousChars && (
        <div className="bg-red-950/40 border border-red-800/50 rounded p-3 text-sm">
          <span className="font-medium text-red-300">🛑 Invisible or confusable characters in the diff</span>
          <p className="mt-1 text-foreground/80">
            Highlighted inline below — bidi-override, zero-width, tag, or homoglyph characters can
            make code display differently than it executes.
          </p>
        </div>
      )}
      {flags.length > 0 && (
        <div className="bg-amber-950/40 border border-amber-800/50 rounded p-3 text-sm">
          <span className="font-medium text-amber-300">⚠️ Self-modifying / load-bearing diff</span>
          <div className="mt-1 space-y-1">
            {flags.map((flag) => (
              <div key={flag.label} className="text-foreground/80">
                <span className="text-amber-400 font-medium">{flag.label}</span>
                {flag.paths.length > 0 && (
                  <span className="text-foreground/50 ml-1">({flag.paths.join(", ")})</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="text-sm text-foreground/60">
        {loopRun ? `${loopRun.iterationsDone} iterations` : "no completed loop run"}
        {wallTime !== null && ` · ${wallTime} min wall time`}
        {diff && ` · ${diff.stat.trim() || "no source changes"} · branch ${diff.branch}`}
      </div>
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {files.length > 0 && <label className="block text-sm text-foreground/60 lg:hidden">Jump to file<select defaultValue="" onChange={(event) => { document.getElementById(event.target.value)?.scrollIntoView({ behavior: "smooth", block: "start" }); event.target.value = ""; }} className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3"><option value="" disabled>Select a changed file</option>{files.map((file, index) => <option key={file.header} value={`diff-file-${index}`}>{file.header}</option>)}</select></label>}

      <div className="flex min-w-0 flex-col items-start gap-4 lg:flex-row">
        <main className="grow min-w-0 flex flex-col gap-2">
          {files.length === 0 && (
            <p className="text-foreground/50 text-sm bg-foreground/[0.04] rounded p-4">
              Empty diff — the loop made no source changes outside <code>.ralph/</code>. Reject with
              feedback or abandon.
            </p>
          )}
          {files.map((file) => (
            <details id={`diff-file-${files.indexOf(file)}`} key={file.header} open className="w-full min-w-0 scroll-mt-4 rounded border border-foreground/10 bg-foreground/[0.03]">
              <summary className="cursor-pointer px-3 py-2 text-sm font-mono text-foreground/80 hover:bg-foreground/[0.05]">
                {file.header}
              </summary>
              <pre className="text-xs font-mono overflow-x-auto px-3 pb-3 leading-5">
                {file.lines.map((line, i) => (
                  <div key={i} className={lineClass(line)}>
                    {renderDiffLineContent(line)}
                  </div>
                ))}
              </pre>
            </details>
          ))}
        </main>

        <aside className="flex w-full min-w-0 shrink-0 flex-col gap-3 lg:sticky lg:top-4 lg:w-80">
          {files.length > 0 && <nav aria-label="Changed files" className="hidden max-h-52 overflow-y-auto rounded border border-foreground/10 bg-foreground/[0.03] p-2 lg:block"><h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-foreground/40">Files</h2>{files.map((file, index) => <a key={file.header} href={`#diff-file-${index}`} className="block min-h-11 truncate rounded px-2 py-3 text-xs text-foreground/65 hover:bg-foreground/[0.05]">{file.header}</a>)}</nav>}
          {plan && (
            <>
              <PlanModelBadge tag={planTag} />
              <details className="bg-foreground/[0.03] rounded border border-foreground/10" open>
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                  CRITERIA.md <span className="text-foreground/40">(run by the evaluator)</span>
                </summary>
                <pre className="whitespace-pre-wrap text-xs px-3 pb-3 text-foreground/70">
                  {plan.acceptanceCriteria}
                </pre>
              </details>
              <details className="bg-foreground/[0.03] rounded border border-foreground/10">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">PLAN.md</summary>
                <pre className="whitespace-pre-wrap text-xs px-3 pb-3 text-foreground/70">{plan.planMd}</pre>
              </details>
            </>
          )}
          {loopRun && loopRun.iterations.length > 0 && (
            <div className="bg-foreground/[0.03] rounded border border-foreground/10 p-3">
              <h3 className="text-sm font-medium mb-1">Final iteration</h3>
              <p className="text-xs text-foreground/70 whitespace-pre-wrap">
                {loopRun.iterations[loopRun.iterations.length - 1].summary ?? "(no summary)"}
              </p>
            </div>
          )}
        </aside>
      </div>

      <footer className="fixed bottom-0 left-0 right-0 z-40 grid grid-cols-2 gap-2 border-t border-foreground/10 bg-surface/95 p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] backdrop-blur sm:flex sm:justify-center">
        <button
          disabled={busy || !loopRun}
          onClick={() => decide("approved")}
          className="min-h-11 rounded bg-green-700 px-3 py-2 text-sm font-medium hover:bg-green-600 disabled:opacity-40 sm:px-4"
        >
          {busy ? "Merging…" : "✓ Approve & merge"}
        </button>
        <button
          disabled={busy || !loopRun}
          onClick={() => setRejecting(true)}
          className="min-h-11 rounded bg-foreground/10 px-3 py-2 text-sm hover:bg-foreground/15 disabled:opacity-40 sm:px-4"
        >
          ✗ Reject with feedback
        </button>
      </footer>

      {rejecting && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
          onMouseDown={(event) => event.target === event.currentTarget && !busy && setRejecting(false)}
        >
          <div
            ref={rejectRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reject-title"
            className="w-full rounded-t-2xl border border-foreground/10 bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-lg sm:rounded-2xl"
          >
            <h3 id="reject-title" className="font-medium mb-2">Reject with feedback</h3>
            <p className="text-xs text-foreground/50 mb-2">
              The feedback becomes the loop’s first task on the next run — be concrete about what to
              change.
            </p>
            <textarea
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={5}
              required
              aria-required="true"
              className="w-full bg-foreground/5 border border-foreground/10 rounded px-2 py-1.5 text-sm font-mono"
            />
            <div className="flex gap-2 justify-end mt-3">
              <button
                onClick={() => setRejecting(false)}
                className="px-3 py-1.5 text-sm text-foreground/60 hover:text-foreground"
              >
                Cancel
              </button>
              <button
                disabled={!feedback.trim() || busy}
                onClick={() => decide("rejected")}
                className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-on-accent font-medium rounded px-3 py-1.5 text-sm"
              >
                Reject &amp; resume loop
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
