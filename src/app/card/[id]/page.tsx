"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { List, useDynamicRowHeight, useListRef, type RowComponentProps } from "react-window";
import { api, timeAgo, useEventStream } from "../../ui/api";
import { AppShell } from "../../ui/appShell";
import { Banner } from "../../ui/banner";
import { DetailsMenu } from "../../ui/detailsMenu";
import { RunsTable, type TranscriptTarget } from "./runsTable";
import { PlanVersions } from "./planVersions";
import { ScopingPanel } from "./scopingPanel";
import { LiveActivity } from "../../ui/liveActivity";
import { EpicTasks } from "./epicTasks";
import { describeToolCall, previewLine } from "../../ui/toolDescription";
import { formatCostUsd } from "../../ui/formatCost";
import { formatProviderModel } from "../../ui/formatProviderModel";
import { plannerModelTag, PlanModelBadge } from "../../ui/planModelBadge";
import { DialogShell, ROLES, ROLE_LABELS, RoleModelSelects, useRoleModelOptions, type RoleModels } from "../../ui/taskDialog";
import { useCardDetail, type CardDetailData } from "./useCardDetail";
import { transcriptPushDecision } from "./transcriptPushDecision";
import {
  filterTranscript,
  transcriptToText,
  type StreamLine as TranscriptStreamLine,
} from "./transcriptSearch";
import { isRenderableLine } from "./renderableLine";
import { CHECKLIST_EXHAUSTED_EXIT, LOOP_BLOCKED_EXIT, retryableFailedStep } from "@/shared/failedStep";
import { PULLBACK_STATUSES, RUNNING_STATUSES, STATUS_LABELS } from "@/shared/cardStatus";
import { parsePayload } from "@/shared/eventPayload";
import { errorMessage } from "@/shared/errorMessage";
import { EVALUATOR_CLEARED_EXITS } from "@/shared/evaluation";
import { scriptKey } from "@/shared/installScripts";
import type { EpicRunMode } from "@/shared/epics";

const TABS = ["Task", "Activity"] as const;

/** How a parent epic's run mode reads in the "Part of" line. */
const RUN_MODE_PHRASES: Record<EpicRunMode, string> = {
  ordered: "in order",
  parallel: "in parallel",
  graph: "as a graph",
};

/** Exporting a card never depends on where it is in its lifecycle. */
const ALL_STATUSES = Object.keys(STATUS_LABELS);

/** Tab names this page used to have, so old links and bookmarks still land
 * somewhere sensible: the plan moved into Task, the transcript became a
 * drill-down inside Activity. */
const RETIRED_TABS: Record<string, (typeof TABS)[number]> = {
  overview: "Task",
  plan: "Task",
  transcript: "Activity",
};

export default function CardDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { detail, error, setError, refetch } = useCardDetail(id);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Task");
  const [transcript, setTranscript] = useState<TranscriptTarget | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [configReview, setConfigReview] = useState<{ runId: string; configHash: string; content: string | null } | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  // Spec 24: Create and break down lands here with ?breakdown=propose.
  const [autoBreakdown, setAutoBreakdown] = useState(false);

  useEffect(() => {
    const readTab = () => {
      const raw = new URLSearchParams(window.location.search).get("tab")?.toLowerCase() ?? "";
      const found = TABS.find((item) => item.toLowerCase() === raw) ?? RETIRED_TABS[raw];
      if (found) setTab(found);
    };
    const readBreakdown = () => {
      const query = new URLSearchParams(window.location.search);
      if (query.get("breakdown") !== "propose") return;
      setAutoBreakdown(true);
      // Off the URL at once: a reload must not spend another model turn.
      query.delete("breakdown");
      window.history.replaceState({}, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
    };
    readTab();
    readBreakdown();
    window.addEventListener("popstate", readTab);
    return () => window.removeEventListener("popstate", readTab);
  }, []);

  function chooseTab(next: (typeof TABS)[number]) {
    setTab(next);
    const query = new URLSearchParams(window.location.search);
    if (next === "Task") query.delete("tab"); else query.set("tab", next.toLowerCase());
    window.history.pushState({}, "", `/card/${id}${query.size ? `?${query}` : ""}`);
  }

  if (!detail)
    return <AppShell><div className="flex min-h-[70dvh] items-center justify-center p-8 text-foreground/50">{error || "Loading task…"}</div></AppShell>;
  const { card, repo, plans, runs } = detail;
  // Spec 24: a card with pieces is an epic. It never runs itself, so its
  // actions are the set's: Start all and Pause all.
  const epicTasks = detail.children ?? [];
  const isEpic = epicTasks.length > 0;
  const epicDone = epicTasks.filter((task) => task.status === "done").length;
  const planTag = plannerModelTag(runs);
  const latestPlan = plans[0];
  // plan_review means the planner is done and the human gate is open — the
  // plan is the thing to read, so it gets a heading and a highlight.
  const awaitingPlanApproval = card.status === "plan_review" && Boolean(latestPlan);
  const latestLoopRun = runs.find((r) => r.kind === "loop");
  const latestEvaluatorRun = runs.find((r) => r.kind === "evaluate");
  const evaluatorCleared =
    !latestEvaluatorRun ||
    (latestEvaluatorRun.status === "completed" &&
      (EVALUATOR_CLEARED_EXITS as readonly string[]).includes(latestEvaluatorRun.exitReason ?? ""));
  const canRetryMerge = latestLoopRun?.status === "completed" && evaluatorCleared;
  const latestIntegrityDecision = detail.events.filter((event) =>
    event.runId === latestLoopRun?.id && ["review.decided", "repo.config_approved"].includes(event.type),
  ).at(-1);
  const configBlocked = card.status === "needs_attention" && canRetryMerge && latestIntegrityDecision &&
    String((parsePayload(latestIntegrityDecision.payload) as { integrityViolation?: string }).integrityViolation ?? "").includes(".git/config changed");
  const failedStep = retryableFailedStep(runs);
  const canRetryFailedStep = Boolean(failedStep && card.status === "needs_attention");
  // Spec 18 §3: the provider rejected the request itself, so retrying the same
  // step is the one thing that cannot help. Say so, and say what would.
  const unretryableRun =
    card.status === "needs_attention" && runs[0]?.failureKind === "config" ? runs[0] : null;
  // Spec 18 §4: the newest reading of "this role keeps failing on this model".
  let misconfiguredStage = "";
  if (card.status === "needs_attention") {
    const latest = detail.events.filter((e) => e.type === "stage.misconfigured").at(-1);
    if (latest) {
      misconfiguredStage = (parsePayload(latest.payload) as { message?: string }).message ?? "";
    }
  }
  const latestPlanRun = runs.find((r) => r.kind === "plan");
  // Phase 15 (weaker network isolation surfacing): which runs actually built
  // their sandbox with `sandboxWeakerIsolationForGoTls` on, per the
  // `sandbox.weaker_isolation_enabled` event context.ts emits once per run.
  const weakerIsolationRunIds = new Set(
    detail.events
      .filter((e) => e.type === "sandbox.weaker_isolation_enabled")
      .map((e) => e.runId),
  );
  const questionsEvent = latestPlanRun && detail.events.find((e) => e.type === "plan.questions" && e.runId === latestPlanRun.id);
  let plannerQuestions = "";
  if (card.status === "needs_attention" && questionsEvent) {
    plannerQuestions = (parsePayload(questionsEvent.payload) as { questions?: string }).questions ?? "";
  }
  // Spec 17: the questions live in the scoping thread, where they are
  // answered. Cards parked before that existed still show them here.
  const scoping = detail.scoping ?? [];
  const questionsInThread = scoping.some((m) => m.role === "planner");
  // The loop stopped for the planner, not for a retry: a blocker outside its
  // control, or a checklist ticked off without DONE. "Plan again" re-plans on
  // top of the branch either way (pendingReplanFeedback).
  const newestRun = runs[0];
  const loopBlocker =
    card.status === "needs_attention" && newestRun?.kind === "loop" && newestRun.exitReason === LOOP_BLOCKED_EXIT
      ? newestRun.feedback || "(no detail recorded)"
      : "";
  const checklistExhausted =
    card.status === "needs_attention" && newestRun?.kind === "loop" && newestRun.exitReason === CHECKLIST_EXHAUSTED_EXIT;
  const blockerInThread = scoping.some((m) => m.role === "loop");
  const planAgain = Boolean(plannerQuestions || loopBlocker || checklistExhausted);
  // Install-script gate (spec 14): a loop halted on unapproved lifecycle
  // scripts — show the packages with their VERBATIM script bodies.
  let gatePackages: GatePackage[] = [];
  if (
    card.status === "needs_attention" &&
    latestLoopRun?.exitReason === "install-script gate"
  ) {
    const gateEvent = detail.events.find(
      (e) => e.type === "install.gate" && e.runId === latestLoopRun.id,
    );
    if (gateEvent) {
      gatePackages = (parsePayload(gateEvent.payload) as { packages?: GatePackage[] }).packages ?? [];
    }
  }

  async function action(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
      refetch();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const post = (path: string, json: object = {}) => action(() => api(`/api/cards/${id}/${path}`, { json }));

  const statusAction: Record<string, { label: string; run: () => void }> = {
    backlog: { label: "Add to Todo", run: () => post("move", { to: "todo" }) },
    todo: { label: "Start now", run: () => post("move", { to: "in_progress" }) },
    needs_attention: canRetryMerge
      ? { label: "Retry merge", run: () => post("retry-merge") }
      : canRetryFailedStep
        ? { label: "Retry failed step", run: () => post("retry-failed-step") }
        : { label: planAgain ? "Plan again" : "Restart task", run: () => post("restart") },
    review: { label: "Review changes", run: () => router.push(`/review/${id}`) },
    plan_review: { label: "Approve plan and implement", run: () => post("approve-plan") },
    paused: { label: "Continue", run: () => post("resume") },
  };
  const headerActions: { label: string; show: boolean; primary?: boolean; run: () => void }[] = [
    { label: "Review Git config", show: Boolean(configBlocked), run: () => action(async () => {
      setConfigReview(await api(`/api/cards/${id}/review-config`, { json: {} }));
    }) },
    { ...statusAction[card.status], show: !isEpic && card.status in statusAction, primary: true },
    { label: "Start all", show: isEpic && epicTasks.some((task) => task.status === "backlog" || task.status === "todo"), primary: true, run: () => post("start-all") },
    { label: "Pause all", show: isEpic && epicTasks.some((task) => task.status === "looping"), run: () => confirm("Pause every running task in this epic after its current iteration?") && post("pause-all") },
    { label: "Pause", show: card.status === "looping", run: () => confirm("Pause this task after the current iteration?") && post("pause") },
    // Every stage reads the card's model override when it starts, so a change
    // made here takes effect on Continue / Retry failed step without
    // discarding the worktree, plan, or iterations so far.
    { label: "Edit model overrides", show: ["paused", "needs_attention"].includes(card.status), run: () => setShowEdit(true) },
    { label: "View activity", show: !isEpic && ["planning", "ready", "looping", "evaluating", "paused", "plan_review"].includes(card.status), primary: true, run: () => chooseTab("Activity") },
    { label: "Open summary", show: card.status === "done", primary: true, run: () => chooseTab("Task") },
  ];
  const confirmThen = (message: string, fn: () => void) => () => { if (confirm(message)) fn(); };
  // `href` rather than `run` for the export: the route answers with
  // Content-Disposition, so a download anchor saves the file and leaves the
  // page where it is. Navigating there through the router would instead ask
  // Next to render an attachment as a page.
  const menuActions: { label: string; when: readonly string[]; danger?: boolean; run?: () => void; href?: string }[] = [
    { label: "Edit task", when: ["backlog", "todo"], run: () => setShowEdit(true) },
    {
      label: "Export as a file",
      when: ALL_STATUSES,
      href: `/api/cards/export?cardId=${encodeURIComponent(id)}`,
    },
    {
      label: "Move to backlog",
      when: PULLBACK_STATUSES,
      run: () => {
        if (!(RUNNING_STATUSES as readonly string[]).includes(card.status) || confirm("Cancel the active run and pull back to Backlog?")) {
          post("move", { to: "backlog" });
        }
      },
    },
    { label: "Abandon task", danger: true, when: ["needs_attention", "review", "plan_review"], run: confirmThen("Abandon this task? Its worktree and branch will be deleted.", () => post("abandon")) },
    { label: "Reset all progress", danger: true, when: ["needs_attention", "review", "plan_review"], run: confirmThen("Reset all progress? This deletes the branch, worktree, and plan, and moves the card back to Backlog.", () => post("reset")) },
    {
      label: "Delete task",
      danger: true,
      when: ["backlog", "todo", "done", "abandoned", "needs_attention"],
      run: confirmThen(isEpic ? "Delete this epic? Its tasks stay, as standalone tasks." : "Delete this task and all its history?", () => action(async () => {
        await api(`/api/cards/${id}`, { method: "DELETE" });
        router.push("/");
      })),
    },
  ];

  return (
    <AppShell>
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 overflow-x-hidden p-4 sm:p-6 lg:py-8">
      <header className="flex min-w-0 items-center gap-3">
        <Link href="/" className="touch-target flex shrink-0 items-center text-sm text-foreground/50 hover:text-foreground">
          ← Work
        </Link>
        <h1 tabIndex={-1} className="min-w-0 grow truncate text-lg font-semibold">{card.title}</h1>
      </header>

      <section className="rounded-xl border border-foreground/[0.08] bg-foreground/[0.025] p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 grow">
            <p className="text-sm text-foreground/75">{repo?.name ?? "Unknown repository"}</p>
            <p className="mt-1 text-xs text-foreground/45">
              {isEpic
                ? `Epic · ${epicDone} of ${epicTasks.length} tasks done`
                : <>{plainStatus(card.status)}{card.startedAt && ` · ${timeAgo(card.startedAt)} elapsed`}</>}
            </p>
          </div>
        {headerActions.filter((a) => a.show).map((a) => (
          <ActionButton key={a.label} primary={a.primary} onClick={a.run}>{a.label}</ActionButton>
        ))}
        <DetailsMenu detailsClassName="relative" summaryClassName="grid size-11 cursor-pointer list-none place-items-center rounded-lg bg-foreground/[0.06] text-foreground/60" menuClassName="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-foreground/10 bg-surface p-1.5 shadow-2xl" ariaLabel="More task actions" summary="•••">
          {menuActions.filter((m) => m.when.includes(card.status)).map((m) => (
            m.href
              ? <a key={m.label} href={m.href} download className={menuItemCls()}>{m.label}</a>
              : <MenuButton key={m.label} danger={m.danger} onClick={m.run!}>{m.label}</MenuButton>
          ))}
        </DetailsMenu>
        </div>
      </section>
      {showEdit && (
        <EditCardModal
          detail={detail}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); refetch(); }}
        />
      )}
      {configReview && (
        <DialogShell
          titleId="review-config-title"
          title="Review Git config"
          closeLabel="Close Git config review"
          onRequestClose={() => { if (!configBusy) setConfigReview(null); }}
          footer={<>
            <button type="button" disabled={configBusy} onClick={() => setConfigReview(null)}>Cancel</button>
            <button type="button" disabled={configBusy} onClick={() => action(async () => {
              setConfigBusy(true);
              try {
                await api(`/api/cards/${id}/approve-config`, { json: { runId: configReview.runId, configHash: configReview.configHash } });
              } finally {
                setConfigBusy(false);
                setConfigReview(null);
                refetch();
              }
            })} className="rounded-lg bg-amber-600 px-5 text-sm font-semibold text-on-accent disabled:opacity-40">
              Accept config and retry merge
            </button>
          </>}
        >
          <p className="mb-3 text-sm">The repository’s Git config changed since this run started. Review the current file below. The original contents were not saved, so a diff is unavailable. Accept only if you recognize and trust this configuration; Git settings can execute commands. Approval applies to this run and this exact version. Hook checks still apply.</p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-foreground/5 p-3 text-xs">{configReview.content ?? "(config file is absent)"}</pre>
        </DialogShell>
      )}
      {error && <p className="text-red-400 text-sm">{error}</p>}
      {unretryableRun && (
        <Banner tone="red" title={`${unretryableRun.provider ?? "The provider"} rejected the request itself`}>
          <pre className="whitespace-pre-wrap text-sm text-red-100/80 font-sans">
            {unretryableRun.exitReason}
          </pre>
          <p className="text-xs text-red-400/70 mt-2">
            Retrying sends the same request, so it will fail the same way. Change the
            model for this card under Edit model overrides, or fix the provider
            configuration, then restart the task.
          </p>
        </Banner>
      )}
      {misconfiguredStage && (
        <Banner tone="amber" title="This stage keeps failing the same way">
          <p className="text-sm text-amber-100/80">{misconfiguredStage}</p>
          <p className="text-xs text-amber-400/70 mt-2">
            Retrying is still available — this is a reading of the pattern, not a block.
          </p>
        </Banner>
      )}
      {plannerQuestions && (
        <Banner tone="amber" title="The planner needs more detail before it can plan this task">
          {!questionsInThread && (
            <pre className="whitespace-pre-wrap text-sm text-amber-100/80 font-sans">
              {plannerQuestions}
            </pre>
          )}
          <p className="text-xs text-amber-400/70 mt-2">
            Answer its questions under Scoping below, then plan again. Editing the description works too.
          </p>
        </Banner>
      )}
      {loopBlocker && (
        <Banner tone="amber" title="The loop stopped on something it cannot resolve">
          {!blockerInThread && (
            <pre className="whitespace-pre-wrap text-sm text-amber-100/80 font-sans">{loopBlocker}</pre>
          )}
          <p className="text-xs text-amber-400/70 mt-2">
            Answer under Scoping below if the planner needs to know something, then plan again. The planner
            re-plans around the blocker on top of the work already on the branch.
          </p>
        </Banner>
      )}
      {checklistExhausted && (
        <Banner tone="amber" title="Every task is ticked, but the loop never signalled done">
          <p className="text-sm text-amber-100/80">
            The final task&rsquo;s own check did not pass. Retrying the loop would find nothing left to do, so plan
            again instead: the planner writes the remaining work on top of what is already on the branch.
          </p>
        </Banner>
      )}
      {gatePackages.length > 0 && (
        <InstallGateBanner cardId={id} packages={gatePackages} onApproved={refetch} />
      )}

      <nav className="-mx-4 overflow-x-auto border-b border-foreground/10 px-4 sm:-mx-6 sm:px-6" aria-label="Task details">
        <div className="flex w-max min-w-full gap-1" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => chooseTab(t)}
            className={`min-h-11 whitespace-nowrap px-3 py-2 text-sm ${
              tab === t ? "border-b-2 border-amber-500 text-foreground" : "text-foreground/50 hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
        </div>
      </nav>

      {tab === "Task" && (
        <section className="flex flex-col gap-4">
          <div className="text-sm text-foreground/70">
            <span className="bg-foreground/10 rounded px-1.5 py-0.5 mr-2">{repo?.name}</span>
            <span className="text-foreground/40">{repo?.path} · Branch: {card.baseBranch ?? repo?.defaultBranch ?? "main"}</span>
          </div>
          {detail.parent && (
            <p className="text-sm text-foreground/60">
              Part of <Link href={`/card/${detail.parent.id}`} className="text-amber-300 hover:underline">{detail.parent.title}</Link>
              {detail.parent.runMode && <span className="text-foreground/40"> · its tasks run {RUN_MODE_PHRASES[detail.parent.runMode]}</span>}
            </p>
          )}
          <pre className="whitespace-pre-wrap text-sm bg-foreground/[0.04] rounded p-3 font-sans">
            {card.description || "(no description)"}
          </pre>
          {isEpic && (
            <EpicTasks cardId={id} runMode={card.runMode ?? null} tasks={epicTasks} onChanged={refetch} onError={setError} />
          )}
          <ScopingPanel
            cardId={id}
            status={card.status}
            scopingAuthorsPlan={Boolean(card.scopingAuthorsPlan)}
            messages={scoping}
            turn={detail.scopingTurn ?? null}
            homeRepoId={repo?.id ?? null}
            autoPropose={autoBreakdown}
            onChanged={refetch}
          />
          <div className="text-sm text-foreground/60">
            Caps: {card.maxIterations ?? "default"} iterations · {card.timeoutMinutes ?? "default"}{" "}
            minutes
          </div>
          {detail.models && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground/60">
              {ROLES.map((role) => {
                const m = detail.models![role];
                return <span key={role}>{ROLE_LABELS[role]}: <span className="font-mono text-foreground/80">{formatProviderModel(m.provider, m.model, m.reasoningLevel)}</span></span>;
              })}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <WorkflowFlag
              on={Boolean(card.reviewPlanBeforeImplementation)}
              label="Review plan before implementation"
            />
            <WorkflowFlag on={Boolean(card.grillMe)} label="Grill me while scoping" />
            <WorkflowFlag on={Boolean(card.scopingAuthorsPlan)} label="Scoping writes the plan" />
            <WorkflowFlag on={card.planCritic == null ? undefined : Boolean(card.planCritic)} label="Plan critic" />
            <WorkflowFlag
              on={Boolean(card.autoApprove)}
              label="Auto-approve on evaluator pass"
              warnWhenOn
            />
          </div>

          {/* The plan, rendered once. It used to live in a Plan tab AND be
              duplicated into the overview during plan_review; the awaiting-
              approval case is now just a heading and an opened PLAN.md. */}
          <div className={awaitingPlanApproval ? "rounded-lg border border-cyan-800/40 bg-cyan-950/20 p-3" : undefined}>
            <h3 className={`text-sm font-medium mb-1 ${awaitingPlanApproval ? "text-cyan-300" : ""}`}>
              {awaitingPlanApproval ? "Generated plan — awaiting your approval" : "Plan"}
            </h3>
            {/* What the planner is doing right now, from its live transcript:
                a re-plan shows it above the plan it is replacing. */}
            {card.status === "planning" && (
              <LiveActivity
                runId={latestPlanRun?.id ?? null}
                startedAt={latestPlanRun?.startedAt}
                idleLabel="Plan is running"
                className="mb-2 text-sm"
              />
            )}
            {latestPlan ? (
              <>
                <PlanModelBadge tag={planTag} />
                <PlanVersions plans={plans} livePlan={detail.livePlan} />
              </>
            ) : (
              card.status !== "planning" && (
                <p className="text-foreground/50 text-sm">No plan yet — start the task to run planning.</p>
              )
            )}
          </div>

          {card.summary && (
            <div>
              <h3 className="text-sm font-medium mb-1">Changes summary</h3>
              <pre className="whitespace-pre-wrap text-sm bg-foreground/[0.04] rounded p-3 font-sans text-green-400/80">
                {card.summary}
              </pre>
            </div>
          )}
        </section>
      )}

      {tab === "Activity" && (transcript ? (
        <section className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setTranscript(null)}
            className="touch-target flex items-center self-start text-sm text-foreground/60 hover:text-foreground"
          >
            ← Back to runs
          </button>
          <TranscriptView target={transcript} />
        </section>
      ) : (
        <section className="flex flex-col gap-4">
          {runs.length > 0 ? (
            <RunsTable
              runs={runs}
              plans={plans}
              models={detail.models}
              cardSummary={card.summary}
              weakerIsolationRunIds={weakerIsolationRunIds}
              onOpenTranscript={setTranscript}
            />
          ) : (
            <p className="text-sm text-foreground/50">No runs yet — start the task to run planning.</p>
          )}
          <div>
            <h3 className="text-sm font-medium mb-1">Events</h3>
            {detail.events.map((e) => {
              const critique = e.type === "critique.decided" ? parseCritiqueDecided(e.payload) : null;
              if (critique) {
                const approved = critique.verdict === "approve";
                return (
                  <div
                    key={e.id}
                    data-testid="critique-decided"
                    className={`my-1 rounded border p-2 text-xs ${approved ? "border-green-800/50 bg-green-950/30" : "border-amber-800/50 bg-amber-950/40"}`}
                  >
                    <span className="font-mono text-foreground/50">{e.createdAt.slice(11, 19)} </span>
                    <span className={`font-medium ${approved ? "text-green-300" : "text-amber-300"}`}>
                      ⚖ Plan critic: {critique.verdict}
                    </span>
                    {critique.feedback && (
                      <p className="mt-1 whitespace-pre-wrap text-foreground/70">{critique.feedback}</p>
                    )}
                  </div>
                );
              }
              return (
                <div key={e.id} className="text-xs text-foreground/50 font-mono">
                  {e.createdAt.slice(11, 19)} {e.type} {e.payload !== "{}" ? e.payload : ""}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
    </AppShell>
  );
}

/** The `critique.decided` event payload (planCriticService): the verdict and
 * the first 500 characters of the critic's feedback. Null when the payload
 * is not shaped that way, so the row falls back to the raw event line. */
function parseCritiqueDecided(payload: string): { verdict: string; feedback: string } | null {
  try {
    const parsed = JSON.parse(payload) as { verdict?: unknown; feedback?: unknown };
    if (typeof parsed.verdict !== "string") return null;
    const feedback = typeof parsed.feedback === "string" ? parsed.feedback.slice(0, 500) : "";
    return { verdict: parsed.verdict, feedback };
  } catch {
    return null;
  }
}

type GatePackage = {
  name: string;
  version: string;
  scriptHash: string;
  scripts: Record<string, string>;
};

/**
 * Install-script gate approval (spec 14): the run is paused with its state
 * preserved; approving runs `npm rebuild` for the CHECKED packages only,
 * remembers them for this repo, and resumes the run in place. The model never
 * sees any of this — it is an out-of-band human decision.
 */
function InstallGateBanner({
  cardId,
  packages,
  onApproved,
}: {
  cardId: string;
  packages: GatePackage[];
  onApproved: () => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>(
    Object.fromEntries(packages.map((p) => [scriptKey(p), true])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = packages.filter((p) => checked[scriptKey(p)]);

  async function approve() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/cards/${cardId}/approve-install`, {
        json: {
          packages: selected.map(({ name, version, scriptHash }) => ({ name, version, scriptHash })),
        },
      });
      onApproved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Banner tone="red" title={`This install wants to execute code from ${packages.length === 1 ? "a package" : "packages"} you haven’t approved`}>
      <p className="text-xs text-red-200/70 mb-2">
        The run is paused with its progress preserved. Review each package&rsquo;s install
        scripts below — approving runs them and resumes the task where it left off.
      </p>
      <div className="flex flex-col gap-2">
        {packages.map((p) => {
          const key = scriptKey(p);
          return (
            <label key={key} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(checked[key])}
                onChange={(e) => setChecked((c) => ({ ...c, [key]: e.target.checked }))}
                className="mt-1"
              />
              <div className="min-w-0">
                <span className="font-mono text-red-100">{p.name}@{p.version}</span>
                <pre className="whitespace-pre-wrap text-xs bg-black/30 rounded p-2 mt-1 font-mono overflow-x-auto text-red-100/80">
                  {Object.entries(p.scripts)
                    .map(([event, body]) => `${event}: ${body}`)
                    .join("\n")}
                </pre>
              </div>
            </label>
          );
        })}
      </div>
      {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
      <button
        onClick={approve}
        disabled={busy || selected.length === 0}
        className="mt-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white font-medium rounded px-3 py-1.5 text-sm"
      >
        {busy ? "Approving…" : `Approve ${selected.length} package${selected.length === 1 ? "" : "s"} and resume`}
      </button>
    </Banner>
  );
}

/** Compact chip for a per-card workflow toggle. An "on" auto-approve flag is
 * amber to flag that this card can merge without human review. `on` of
 * `undefined` means the card inherits the global default (tri-state flags
 * such as the plan critic). */
function WorkflowFlag({ on, label, warnWhenOn }: { on: boolean | undefined; label: string; warnWhenOn?: boolean }) {
  const tone = on
    ? warnWhenOn
      ? "border-amber-600/50 bg-amber-950/30 text-amber-300"
      : "border-foreground/15 bg-foreground/[0.06] text-foreground/75"
    : "border-foreground/10 text-foreground/40";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${tone}`}>
      <span aria-hidden>{on ? "●" : on === undefined ? "◌" : "○"}</span>
      {label}: {on === undefined ? "Default" : on ? "On" : "Off"}
    </span>
  );
}

function plainStatus(status: string): string {
  return (STATUS_LABELS as Record<string, string>)[status] ?? status;
}

function ActionButton({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-3 py-1.5 text-sm ${primary ? "bg-amber-600 hover:bg-amber-500 text-on-accent font-medium" : "bg-foreground/10 hover:bg-foreground/15"}`}
    >
      {children}
    </button>
  );
}

/** Shared by the menu's buttons and its one download link. */
function menuItemCls(danger?: boolean) {
  return `flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-foreground/[0.06] ${danger ? "text-red-300" : ""}`;
}

function MenuButton({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return <button type="button" onClick={onClick} className={menuItemCls(danger)}>{children}</button>;
}

// Defined alongside the search/export helpers that have to agree with the
// renderer below on what a line's text is.
type StreamLine = TranscriptStreamLine;

// Was 2_000 pre-virtualization, capped mainly to bound *render* cost — with
// react-window only visible rows ever hit the DOM, so render cost no longer
// scales with this number. Raised, not removed: each StreamLine still lives
// in a JS array in the tab's memory (tool inputs/text deltas can run to a
// few KB apiece), and an hours-long chatty loop iteration can otherwise
// accumulate lines indefinitely, so this is now purely a memory backstop.
const MAX_TRANSCRIPT_LINES = 20_000;

function TranscriptView({ target }: { target: TranscriptTarget | null }) {
  // Live is the run's state, not the card's: a finished planning run's
  // transcript never changes while the loop runs, so it has nothing to
  // subscribe to.
  const live = target?.live ?? false;
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  // The rows the List actually renders. Everything downstream — the tail
  // follow, "Jump to latest", the row-height cache — has to index into THIS
  // array, not `lines`, or a filtered view scrolls to a row that isn't there.
  const visibleLines = useMemo(() => filterTranscript(lines, filter), [lines, filter]);
  // Imperative handle onto react-window's List, replacing the old
  // bottomRef.current?.scrollIntoView(...) sentinel — the list no longer
  // renders every line as a real DOM node, so there's nothing to scroll a
  // ref-anchored div into view *of*; scrollToRow targets a row index instead.
  const listRef = useListRef(null);
  // Rows are variable height: "text" lines wrap to however many lines their
  // content needs, and "tool" lines are a collapsed <details> that grows
  // when expanded. useDynamicRowHeight measures each row's real rendered
  // height via ResizeObserver and feeds it back into List automatically.
  // defaultRowHeight is only the pre-measurement estimate (single-line row).
  // Keyed by target so switching runs/iterations doesn't reuse a stale
  // height cache from a previous transcript's totally different content.
  // The filter is part of the key: narrowing the list puts different content
  // at every index, so a cache measured against the unfiltered rows would size
  // the filtered ones wrong.
  const rowHeight = useDynamicRowHeight({
    defaultRowHeight: 28,
    key: target ? `${target.runId}:${target.iteration}:${filter.trim()}` : undefined,
  });

  // Cursor/in-flight bookkeeping lives in refs, not state — it's shared
  // between the fetch effect below and the SSE push handler, and neither
  // should re-run/re-subscribe just because a byte offset changed.
  const cursorRef = useRef(0);
  const firstRef = useRef(true);
  // True until some chunk has put rows on screen for the current target —
  // the "previous.length > 0" the scroll decision needs, kept outside state.
  const firstChunkRef = useRef(true);
  const inFlightRef = useRef(false);
  const stopRef = useRef(false);
  const catchUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True until a fetch chain has drained fully (hasMore: false) against the
  // *current* cursor — i.e. until we know our cursor lines up with the live
  // watcher's own cursor sequence server-side. Pushes arriving before that
  // point can't be trusted to append cleanly (our fetch and the server's
  // file watcher are two independent readers of the same growing file, so a
  // push's line range isn't guaranteed to start exactly where our last fetch
  // left off) — treat them as a "there's more, go fetch" signal instead of
  // applying their lines directly. Re-armed on an SSE reconnect, since a
  // dropped connection may have missed pushes written during the gap.
  const needsResyncRef = useRef(true);
  const wasDisconnectedRef = useRef(false);
  // Whether the view is following the tail: re-decided by every appended
  // chunk from where the reader is, and acted on by the effect below after
  // each commit, for the row count the List actually has. The scroll used to
  // fire from a requestAnimationFrame inside the setLines updater with the
  // updater's own length, which raced the commit two ways: chunks arriving
  // faster than React renders meant the frame could run against a List whose
  // rowCount was still the old one, and react-window threw
  // `RangeError: Invalid index specified` for the not-yet-rendered last row.
  const followTailRef = useRef(false);
  useEffect(() => {
    if (!followTailRef.current || visibleLines.length === 0) return;
    listRef.current?.scrollToRow({ index: visibleLines.length - 1, align: "end" });
  }, [visibleLines, listRef]);

  const applyChunk = useCallback(
    (d: { lines?: StreamLine[]; cursor: number; truncated?: boolean; reset?: boolean }, replace: boolean) => {
      cursorRef.current = d.cursor;
      // The list's own outer element is now the scroll container (the page
      // around it no longer grows with line count), so "near bottom" reads
      // its scrollTop/scrollHeight instead of window.scrollY. No element yet
      // (e.g. the very first chunk, before any row has ever rendered) counts
      // as near-bottom — there's nothing to preserve a scroll position of.
      const el = listRef.current?.element;
      const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 96;
      // Drop the lines the view can't draw before they ever reach state (see
      // renderableLine.ts) — a chunk that is nothing but raw framing must not
      // grow the list, move the scroll anchor, or raise "Jump to latest".
      const incoming = (d.lines ?? []).filter(isRenderableLine);
      // An append to a view that already has rows either follows the tail or
      // raises "Jump to latest". Decided here, outside the updater, which
      // must stay pure: the scroll itself waits for the commit (see
      // followTailRef), and the very first chunk has nothing to follow.
      const appending = !replace && !d.reset && incoming.length > 0 && !firstChunkRef.current;
      if (appending) {
        followTailRef.current = nearBottom;
        if (!nearBottom) setShowJump(true);
      }
      if (incoming.length > 0) firstChunkRef.current = false;
      setLines((previous) => {
        const merged = replace || d.reset ? incoming : [...previous, ...incoming];
        return merged.slice(-MAX_TRANSCRIPT_LINES);
      });
      if (d.truncated !== undefined) setHistoryTruncated(d.truncated);
      if (replace) setShowJump(false);
    },
    [listRef],
  );

  // Cursor-based fetch via /api/runs/[id] — used for the initial/historical
  // load, to drain any backlog reported by `hasMore`, and to resync after an
  // SSE reconnect. Live tailing itself comes from the `transcript` push
  // handler below, not a repeated fetch.
  const load = useCallback(
    async (t: TranscriptTarget) => {
      if (stopRef.current || inFlightRef.current) return;
      inFlightRef.current = true;
      const replace = firstRef.current;
      const cursorQuery = live || !replace ? `&cursor=${cursorRef.current}` : "";
      try {
        const d = await api<{
          lines: StreamLine[];
          cursor: number;
          hasMore: boolean;
          truncated: boolean;
          reset: boolean;
        }>(`/api/runs/${t.runId}?iteration=${t.iteration}${cursorQuery}`);
        if (stopRef.current) return;
        firstRef.current = false;
        applyChunk(d, replace);
        if (d.hasMore) {
          catchUpTimerRef.current = setTimeout(() => void load(t), 0);
        } else {
          needsResyncRef.current = false;
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [live, applyChunk],
  );

  // Initial / historical load: fires once per target (and again if `live`
  // flips). A finished run's transcript never changes again, so this is the
  // only fetch a non-live view ever needs; for a live view it's just the
  // catch-up before live pushes take over.
  useEffect(() => {
    if (!target) return;
    stopRef.current = false;
    cursorRef.current = 0;
    firstRef.current = true;
    firstChunkRef.current = true;
    followTailRef.current = false;
    needsResyncRef.current = true;
    void load(target);
    return () => {
      stopRef.current = true;
      if (catchUpTimerRef.current) clearTimeout(catchUpTimerRef.current);
    };
  }, [target?.runId, target?.iteration, live, load]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live tail: push instead of poll (Phase 16 chunk A). The SSE route
  // forwards `bus`'s `"transcript"` channel alongside the durable event feed
  // (src/app/api/events/stream/route.ts) — a plain in-memory push, never
  // written to the `events` table (see TranscriptPush's doc comment in
  // src/server/events.ts).
  useEventStream(
    (raw) => {
      if (!live || !target || stopRef.current) return;
      const msg = raw as unknown as {
        kind?: string;
        runId?: string;
        iteration?: number;
        fromCursor?: number;
        cursor?: number;
        lines?: StreamLine[];
      };
      if (msg.kind !== "transcript") return;
      if (msg.runId !== target.runId || msg.iteration !== target.iteration) return;
      if (typeof msg.cursor !== "number") return;
      // See transcriptPushDecision's doc comment: a push can overlap (or, in
      // theory, gap) the client's own cursor because the server-side watcher
      // and this component's own fetch loop are two independent readers of
      // the same growing file — only a clean handoff is safe to append
      // directly, anything else falls back to a cursor-based resync fetch.
      const decision = transcriptPushDecision(msg, cursorRef.current, needsResyncRef.current);
      if (decision === "ignore") return;
      if (decision === "resync") {
        void load(target);
        return;
      }
      applyChunk({ lines: msg.lines ?? [], cursor: msg.cursor }, false);
    },
    (connected) => {
      if (!connected) {
        wasDisconnectedRef.current = true;
        return;
      }
      // Only a genuine reconnect (we saw a drop first) needs a resync — the
      // very first `onopen` right after mount is already covered by the
      // effect above's initial load().
      if (wasDisconnectedRef.current) {
        wasDisconnectedRef.current = false;
        needsResyncRef.current = true;
        if (target) void load(target);
      }
    },
  );

  if (!target) return <p className="text-foreground/50 text-sm">No runs yet.</p>;

  return (
    <section className="flex min-w-0 flex-col gap-1 font-mono text-xs">
      <div className="mb-1 flex min-h-11 items-center gap-2 text-foreground/40">
      <p>
        {formatProviderModel(target.provider, target.model, target.reasoningLevel)} · run {target.runId} ·{" "}
        {target.iteration ? `iteration ${target.iteration}` : "planning"}
        {live && <span className="text-amber-300"> · ● Live</span>}
      </p>
      {showJump && <button type="button" onClick={() => { listRef.current?.scrollToRow({ index: visibleLines.length - 1, align: "end", behavior: "smooth" }); setShowJump(false); }} className="ml-auto rounded-lg bg-amber-500/15 px-3 text-xs text-amber-200">Jump to latest</button>}
      </div>

      {lines.length > 0 && (
        <div className="flex min-h-11 flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="transcript-filter">Filter transcript</label>
          <input
            id="transcript-filter"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && filter) { event.preventDefault(); setFilter(""); } }}
            placeholder="Filter lines…"
            className="min-h-11 min-w-0 grow rounded-lg border border-foreground/10 bg-foreground/[0.05] px-3 font-sans text-sm sm:max-w-xs"
          />
          <span aria-live="polite" className="tabular-nums text-foreground/45">
            {filter.trim() ? `${visibleLines.length} of ${lines.length} lines` : `${lines.length} lines`}
          </span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(transcriptToText(visibleLines)).then(
                () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
                () => setCopied(false),
              );
            }}
            className="ml-auto min-h-11 rounded-lg bg-foreground/[0.06] px-3 font-sans text-xs text-foreground/70 hover:bg-foreground/[0.10]"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => downloadTranscript(target, visibleLines)}
            className="min-h-11 rounded-lg bg-foreground/[0.06] px-3 font-sans text-xs text-foreground/70 hover:bg-foreground/[0.10]"
          >
            Download
          </button>
        </div>
      )}

      {historyTruncated && <p className="text-foreground/40">Showing the latest transcript chunk.</p>}
      {lines.length === 0 ? (
        <p className="text-foreground/40">No transcript output yet…</p>
      ) : visibleLines.length === 0 ? (
        <p className="font-sans text-sm text-foreground/40">No lines match “{filter.trim()}”.</p>
      ) : (
        <List
          listRef={listRef}
          rowComponent={TranscriptRow}
          rowCount={visibleLines.length}
          rowHeight={rowHeight}
          rowProps={{ lines: visibleLines }}
          defaultHeight={480}
          overscanCount={10}
          style={{ height: "70dvh" }}
          className="rounded"
        />
      )}
    </section>
  );
}

/** Save the transcript as a `.txt` beside whatever else is being collected for
 * a bug report — named for the run and iteration it came from, since a loose
 * `transcript.txt` in Downloads tells you nothing a week later. */
function downloadTranscript(target: TranscriptTarget | null, lines: StreamLine[]) {
  if (!target) return;
  const suffix = target.iteration ? `iteration-${target.iteration}` : "planning";
  const blob = new Blob([transcriptToText(lines)], { type: "text/plain;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `radulf-${target.runId}-${suffix}.txt`;
  anchor.click();
  URL.revokeObjectURL(href);
}

// react-window's row wrapper: the DOM node it renders becomes a *direct*
// child of the list's scroll container (react-window walks
// containerElement.children to attach its ResizeObserver), so the
// positioning `style` it hands us must land on that outer element, not
// somewhere nested inside TranscriptLine's own markup.
function TranscriptRow({ index, style, ariaAttributes, lines }: RowComponentProps<{ lines: StreamLine[] }>) {
  return (
    <div style={style} {...ariaAttributes}>
      <TranscriptLine line={lines[index]} />
    </div>
  );
}

function TranscriptLine({ line }: { line: StreamLine }) {
  if (line.t === "text") {
    return (
      <div className="whitespace-pre-wrap text-foreground/85 bg-foreground/[0.04] rounded p-2 my-0.5 font-sans text-sm">
        {String(line.content ?? "")}
      </div>
    );
  }
  if (line.t === "reasoning") {
    const content = String(line.content ?? "");
    return (
      <details className="my-0.5 text-foreground/50">
        <summary className="cursor-pointer hover:text-foreground/80">
          ✻ reasoning
          {content && <span className="text-foreground/40 ml-2">{previewLine(content)}</span>}
        </summary>
        <div className="whitespace-pre-wrap pl-4 pt-1 font-sans text-sm text-foreground/45 italic">
          {content || "(redacted by the provider)"}
        </div>
      </details>
    );
  }
  if (line.t === "tool") {
    const desc = describeToolCall(String(line.name ?? ""), line.input);
    return (
      <details className="text-foreground/50">
        <summary className="cursor-pointer hover:text-foreground/80">
          ⚒ {String(line.name ?? "")}
          {desc && (
            <span className="text-foreground/40 font-mono ml-2">{desc}</span>
          )}
        </summary>
        <pre className="whitespace-pre-wrap pl-4 text-foreground/40 overflow-x-auto">
          {JSON.stringify(line.input, null, 2)?.slice(0, 2000)}
        </pre>
      </details>
    );
  }
  if (line.t === "result") {
    const isFailed = line.exit === "failed";
    return (
      <div className={`${isFailed ? "text-red-400" : "text-green-500/70"} mt-1`}>
        ■ result: {isFailed ? String(line.detail ?? "unknown error") : "ok"}
      </div>
    );
  }
  if (line.t === "usage") {
    // costUsd is absent whenever the harness didn't price the turn — say
    // nothing rather than imply the turn was free.
    const cost = typeof line.costUsd === "number" ? line.costUsd : null;
    return (
      <div className="text-foreground/30 mt-1">
        ▸ tokens: {String(line.inputTokens ?? 0)} in / {String(line.outputTokens ?? 0)} out
        {cost != null && ` · ${formatCostUsd(cost)}`}
      </div>
    );
  }
  return null;
}

function EditCardModal({
  detail,
  onClose,
  onSaved,
}: {
  detail: CardDetailData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(detail.card.title);
  const [description, setDescription] = useState(detail.card.description);
  const [roleModels, setRoleModels] = useState<RoleModels>({
    planner: detail.card.plannerModel ?? "",
    loop: detail.card.loopModel ?? "",
    evaluator: detail.card.evaluatorModel ?? "",
  });
  const [grillMe, setGrillMe] = useState(Boolean(detail.card.grillMe));
  const [scopingAuthorsPlan, setScopingAuthorsPlan] = useState(Boolean(detail.card.scopingAuthorsPlan));
  const [planCritic, setPlanCritic] = useState<boolean | null>(
    detail.card.planCritic == null ? null : Boolean(detail.card.planCritic),
  );
  const { providers, models } = useRoleModelOptions();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fieldCls = "bg-foreground/5 border border-foreground/10 rounded px-2 py-1.5 text-sm";

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/cards/${detail.card.id}`, {
        method: "PATCH",
        json: {
          title,
          description,
          plannerModel: roleModels.planner || null,
          loopModel: roleModels.loop || null,
          evaluatorModel: roleModels.evaluator || null,
          grillMe,
          scopingAuthorsPlan,
          planCritic,
        },
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <DialogShell
      titleId="edit-task-title"
      title="Edit task"
      closeLabel="Close edit task"
      onRequestClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="rounded-lg px-4 text-sm text-foreground/60">Cancel</button>
        <button type="button" onClick={save} disabled={busy || !title.trim()} className="rounded-lg bg-amber-600 px-5 text-sm font-semibold text-on-accent disabled:opacity-40">Save</button>
      </>}
    >
      <div className="flex flex-col gap-3">
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className={fieldCls} />
        <RoleModelSelects providers={providers} models={models} values={roleModels} onChange={setRoleModels} idPrefix="edit-" />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description — include a definition of done. The planner only sees this."
          rows={6}
          className={`${fieldCls} font-mono`}
        />
        <label className="flex items-center gap-2 text-sm text-foreground/70">
          <input
            type="checkbox"
            checked={grillMe}
            onChange={(e) => setGrillMe(e.target.checked)}
            className="size-4 accent-amber-600"
          />
          Grill me while scoping
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground/70">
          <input
            type="checkbox"
            checked={scopingAuthorsPlan}
            onChange={(e) => setScopingAuthorsPlan(e.target.checked)}
            className="size-4 accent-amber-600"
          />
          Let scoping write the plan
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground/70">
          Plan critic
          <select
            value={planCritic === null ? "default" : planCritic ? "on" : "off"}
            onChange={(e) => setPlanCritic(e.target.value === "default" ? null : e.target.value === "on")}
            className={fieldCls}
          >
            <option value="default">Default (on for breakdown pieces)</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>
    </DialogShell>
  );
}
