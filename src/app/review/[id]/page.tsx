"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, useEventStream } from "../../ui/api";
import { formatDuration } from "../../ui/formatDuration";
import { Banner } from "../../ui/banner";
import { DetailsMenu } from "../../ui/detailsMenu";
import { parseEvaluation } from "@/shared/evaluation";
import { plannerModelTag, PlanModelBadge } from "../../ui/planModelBadge";
import { DialogShell, dialogInputCls } from "../../ui/taskDialog";
import { classifySelfModifying } from "./selfModifying";
import { diffHeaderPath } from "./diffHeader";
import { classifySensitivePaths, changedIgnoreFiles } from "./sensitivePaths";
import { hasSuspiciousChars, segmentSuspiciousChars, type DiffLineSegment } from "@/shared/diffSafety";
import { DoneSummaryView } from "./doneSummaryView";
import { errorMessage } from "@/shared/errorMessage";
import type { CardDetailData } from "../../card/[id]/useCardDetail";
import type { DiffResponse } from "../../api/cards/[id]/diff/route";

/** A diff line with its suspicious-character segments, scanned once when the
 * diff is parsed rather than on every render. */
type DiffLine = { text: string; segments: DiffLineSegment[] };
type DiffFile = { header: string; lines: DiffLine[] };

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { header: diffHeaderPath(line), lines: [] };
      files.push(current);
    } else if (current) {
      current.lines.push({ text: line, segments: segmentSuspiciousChars(line) });
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
function renderDiffLineContent({ text, segments }: DiffLine) {
  if (!text) return " ";
  if (segments.length === 1 && segments[0].kind === "text") return text;
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
  const [detail, setDetail] = useState<CardDetailData | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");

  const refetch = useCallback(() => {
    api<CardDetailData>(`/api/cards/${id}`).then(setDetail).catch((e) => setError(String(e)));
    api<DiffResponse>(`/api/cards/${id}/diff`).then(setDiff).catch((e) => setError(String(e)));
  }, [id]);
  useEffect(refetch, [refetch]);
  const wasDisconnected = useRef(false);
  useEventStream(
    (event) => {
      if (event.cardId === id) refetch();
    },
    (connected) => {
      if (!connected) {
        wasDisconnected.current = true;
        return;
      }
      // Missed events aren't replayed: refetch on a genuine reconnect, not on
      // the first open after mount, which the initial load already covers.
      if (wasDisconnected.current) {
        wasDisconnected.current = false;
        refetch();
      }
    },
  );

  const files = useMemo(() => (diff ? parseDiff(diff.diff) : []), [diff]);
  const evaluation = useMemo(() => (diff?.evaluation ? parseEvaluation(diff.evaluation) : null), [diff]);
  const flags = useMemo(() => classifySelfModifying(files.map((f) => f.header)), [files]);
  const sensitiveFlags = useMemo(() => classifySensitivePaths(files.map((f) => f.header)), [files]);
  const ignoreFilesChanged = useMemo(() => changedIgnoreFiles(files.map((f) => f.header)), [files]);
  const hasSuspicious = useMemo(() => (diff ? hasSuspiciousChars(diff.diff) : false), [diff]);
  const loopRun = detail?.runs.find((r) => r.kind === "loop" && r.status === "completed");
  const plan = detail?.plans[0];
  const planTag = detail ? plannerModelTag(detail.runs) : null;
  const wallTime = loopRun?.endedAt ? formatDuration(loopRun.startedAt, loopRun.endedAt) : null;

  async function decide(decision: "approved" | "rejected") {
    if (!loopRun) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/reviews", { json: { runId: loopRun.id, decision, feedback } });
      router.push("/");
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  async function abandon() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/cards/${id}/abandon`, { json: {} });
      router.push("/");
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  if (!detail) return <div className="p-8 text-foreground/50">{error || "Loading…"}</div>;

  return (
    <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-4 overflow-x-hidden p-4 pb-28 sm:p-6 sm:pb-28">
      <header className="flex min-w-0 items-center gap-3">
        <Link href="/" className="touch-target flex shrink-0 items-center text-sm text-foreground/50 hover:text-foreground">
          ← Work
        </Link>
        <h1 tabIndex={-1} className="min-w-0 grow truncate text-lg font-semibold">Review: {detail.card.title}</h1>
        <DetailsMenu detailsClassName="relative" summaryClassName="grid size-11 cursor-pointer list-none place-items-center rounded-lg bg-foreground/[0.06] text-foreground/60" menuClassName="absolute right-0 z-30 mt-2 w-56 rounded-xl border border-foreground/10 bg-surface p-1.5 shadow-xl" ariaLabel="Review options" summary="•••">
          <Link href={`/card/${id}`} className="flex min-h-11 items-center rounded-lg px-3 text-sm hover:bg-foreground/[0.06]">Open task details</Link>
          <button disabled={busy} onClick={() => { if (confirm("Abandon this task? Its worktree and branch will be deleted.")) void abandon(); }} className="min-h-11 w-full rounded-lg px-3 text-left text-sm text-red-300 hover:bg-red-500/10">Abandon task</button>
        </DetailsMenu>
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
        <Banner tone="red" title="🛑 Touches sandbox / security-critical code"><FlagList flags={sensitiveFlags} tone="text-red-400" /></Banner>
      )}
      {ignoreFilesChanged.length > 0 && (
        <Banner tone="red" title="🛑 .gitignore / .gitattributes changed">
          <p>
            These files can hide content from <code>git add</code> or from how a diff renders:{" "}
            {ignoreFilesChanged.join(", ")}
          </p>
        </Banner>
      )}
      {hasSuspicious && (
        <Banner tone="red" title="🛑 Invisible or confusable characters in the diff">
          <p>
            Highlighted inline below — bidi-override, zero-width, tag, or homoglyph characters can
            make code display differently than it executes.
          </p>
        </Banner>
      )}
      {flags.length > 0 && (
        <Banner tone="amber" title="⚠️ Self-modifying / load-bearing diff"><FlagList flags={flags} tone="text-amber-400" /></Banner>
      )}
      <div className="text-sm text-foreground/60">
        {loopRun ? `${loopRun.iterationsDone} iterations` : "no completed loop run"}
        {wallTime && ` · ${wallTime} wall time`}
        {diff && ` · ${diff.stat.trim() || "no source changes"} · branch ${diff.branch}`}
      </div>
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {files.length > 0 && <label className="block text-sm text-foreground/60 lg:hidden">Jump to file<select defaultValue="" onChange={(event) => { document.getElementById(event.target.value)?.scrollIntoView({ behavior: "smooth", block: "start" }); event.target.value = ""; }} className={dialogInputCls}><option value="" disabled>Select a changed file</option>{files.map((file, index) => <option key={file.header} value={`diff-file-${index}`}>{file.header}</option>)}</select></label>}

      <div className="flex min-w-0 flex-col items-start gap-4 lg:flex-row">
        <main className="grow min-w-0 flex flex-col gap-2">
          {files.length === 0 && (
            <p className="text-foreground/50 text-sm bg-foreground/[0.04] rounded p-4">
              Empty diff — the loop made no source changes outside <code>.ralph/</code>. Reject with
              feedback or abandon.
            </p>
          )}
          {files.map((file, index) => (
            <details id={`diff-file-${index}`} key={file.header} open className="w-full min-w-0 scroll-mt-4 rounded border border-foreground/10 bg-foreground/[0.03]">
              <summary className="cursor-pointer px-3 py-2 text-sm font-mono text-foreground/80 hover:bg-foreground/[0.05]">
                {file.header}
              </summary>
              <pre className="text-xs font-mono overflow-x-auto px-3 pb-3 leading-5">
                {file.lines.map((line, i) => (
                  <div key={i} className={lineClass(line.text)}>
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
        <DialogShell
          titleId="reject-title"
          title="Reject with feedback"
          closeLabel="Close reject with feedback"
          onRequestClose={() => { if (!busy) setRejecting(false); }}
          footer={<>
            <button type="button" onClick={() => setRejecting(false)} className="rounded-lg px-4 text-sm text-foreground/60">Cancel</button>
            <button type="button" disabled={!feedback.trim() || busy} onClick={() => decide("rejected")} className="rounded-lg bg-amber-600 px-5 text-sm font-semibold text-on-accent disabled:opacity-40">Reject &amp; re-plan</button>
          </>}
        >
          <p className="text-xs text-foreground/50">
            The planner re-plans this task with your feedback, on top of the work already done — be
            concrete about what to change.
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
        </DialogShell>
      )}
    </div>
  );
}

function FlagList({ flags, tone }: { flags: { label: string; paths: string[] }[]; tone: string }) {
  return flags.map((flag) => (
    <div key={flag.label}>
      <span className={`${tone} font-medium`}>{flag.label}</span>
      {flag.paths.length > 0 && <span className="text-foreground/50 ml-1">({flag.paths.join(", ")})</span>}
    </div>
  ));
}
