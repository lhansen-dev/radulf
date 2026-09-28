// The boot sequence for a Radulf process, independent of Next.js so that both
// `src/instrumentation.ts` (under `next start` / `next dev`) and `src/worker.ts`
// (a plain Node process) can run the same code. Which parts run depends on the
// roles the process was given — see ./roles.
import { ensureAuthSecret } from "./authSecret";
import { getSettings } from "./settings";
import { initializeSandboxRuntimeOnce } from "./sandbox/srt";
import { getOrchestrator } from "./orchestrator";
import { resumeImprovementRuns } from "./improvementRuns";
import { registerShutdownHandlers } from "./shutdown";
import { claimDailySweep, pruneRuntimeHistory, removeFinishedWorktrees } from "./retention";
import { fireDueSchedules } from "./schedules";
import { startEventsTail } from "./eventsTail";
import { startTranscriptWatchers } from "./transcriptWatchers";
import type { Role } from "./roles";

export async function boot(roles: ReadonlySet<Role>): Promise<void> {
  console.log(`[radulf] roles: ${[...roles].join(",")}`);

  ensureAuthSecret();

  // Opens and migrates the database at boot for every role rather than on
  // the first request.
  const settings = getSettings();

  // Spec 25 decision 5: events fan out through the `events` table. Every role
  // tails it and re-emits rows other processes inserted on the local bus, so a
  // split web/worker deployment sees every event. The web role owns one live
  // transcript watcher per running run (whichever process runs the harness),
  // so SSE clients get transcripts pushed from the process they connect to.
  startEventsTail();
  if (roles.has("web")) startTranscriptWatchers();

  // A web-only process stops here — it tails events and watches transcripts
  // (above), but runs no sandbox preflight, no orchestrator, no boot recovery,
  // no pump, no improvement-run drivers, no shutdown drain, no retention or
  // schedule timers.
  if (!roles.has("worker")) return;

  // Spec 14 Phase 6: startup preflight, not first-command discovery — a
  // sandboxEnabled run started before this resolves awaits the same
  // cached promise (initializeSandboxRuntimeOnce is memoized) and fails
  // loudly before its first iteration if this reports errors, rather
  // than discovering a broken sandbox mid-run.
  if (settings.sandboxEnabled) {
    const preflight = await initializeSandboxRuntimeOnce();
    if (!preflight.ok) {
      console.error(
        "[radulf] sandbox preflight failed — every sandboxEnabled run will fail into " +
          "Needs Attention until this is fixed (or sandboxEnabled is turned off in Settings):\n" +
          preflight.errors.map((e) => `  - ${e}`).join("\n"),
      );
    }
    for (const w of preflight.warnings) console.warn(`[radulf] sandbox warning: ${w}`);
  }

  const orchestrator = getOrchestrator();

  // recover() (inside getOrchestrator()) has already flipped any orphaned
  // card to needs_attention, so it's safe to reattach improvement-run
  // drivers now.
  resumeImprovementRuns();

  registerShutdownHandlers(orchestrator);

  // Spec 25: a card another process moved to Todo arrives with no in-process
  // signal, so the worker polls the queue as well as pumping on its own
  // transitions. pump() is idempotent and returns at once while draining.
  // Deliberately not unref()'d — this timer is what keeps a plain Node worker
  // alive.
  //
  // The same tick also adopts improvement runs: a web-only process inserts an
  // improvement-run row without driving it (spec 25 — no pi session in web),
  // so the worker re-scans `running` improvement runs on every pump tick.
  // driveRun is idempotent per process (driverGuard()), so runs already being
  // driven here are skipped.
  //
  // And it reclaims what a finished card leaves behind: a web-only abandon
  // moves the card but never writes to the repository (spec 25), and a
  // delivery worker killed after it moved the card to done but before it
  // removed its worktree leaves the same worktree, branch, row and baseline
  // sitting there. Either way they wait here for a worker. A sweep still
  // running when the next tick fires is left to finish.
  let sweepingWorktrees = false;
  const sweepFinishedWorktrees = async () => {
    if (sweepingWorktrees) return;
    sweepingWorktrees = true;
    try {
      const removed = await removeFinishedWorktrees();
      if (removed > 0) console.log(`[radulf] removed ${removed} finished-card worktree(s)`);
    } catch (e) {
      console.error("[radulf] finished worktree sweep failed:", e);
    } finally {
      sweepingWorktrees = false;
    }
  };
  const PUMP_INTERVAL_MS = Math.max(100, Number(process.env.RADULF_PUMP_INTERVAL_MS) || 5_000);
  setInterval(() => {
    try {
      orchestrator.pump();
      resumeImprovementRuns();
      void sweepFinishedWorktrees();
    } catch (e) {
      console.error("[radulf] queue pump failed:", e);
    }
  }, PUMP_INTERVAL_MS);

  // PLAN.md Phase 7: pruneRuntimeHistory previously only ran when a human
  // hit the manual /api/maintenance/cleanup endpoint, so transcripts and
  // events accumulated unbounded on every deploy that nobody visited that
  // endpoint on. Sweep automatically once per UTC day, plus once shortly
  // after boot so a long-running dev/staging instance doesn't wait a full
  // day for its first cleanup. No Settings field for the window yet — 30
  // days is a hardcoded default; revisit if anyone asks for control over it.
  //
  // Spec 25 decision 7: the sweep runs in every worker, and the daily marker
  // compare-and-set in claimDailySweep ensures exactly one worker prunes per
  // UTC day — the others see the marker already stamped and return without
  // pruning or logging. The timer fires hourly rather than daily so a worker
  // booted later than its peer still gets its turn on a following day
  // instead of always arriving after the peer has already claimed it.
  const RETENTION_DAYS = 30;
  const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
  const RETENTION_INITIAL_DELAY_MS = 60_000;
  const runRetentionSweep = async () => {
    try {
      if (!claimDailySweep()) return;
      const result = await pruneRuntimeHistory(RETENTION_DAYS);
      console.log(`[radulf] retention sweep: ${JSON.stringify(result)}`);
    } catch (e) {
      console.error("[radulf] retention sweep failed:", e);
    }
  };
  setTimeout(() => void runRetentionSweep(), RETENTION_INITIAL_DELAY_MS);
  setInterval(() => void runRetentionSweep(), RETENTION_INTERVAL_MS);

  // Spec 22: the scheduler. One tick a minute, aligned to the start of the
  // minute so a schedule fires when its expression says rather than
  // whenever the process happened to boot. A missed tick is missed, never
  // replayed — see fireDueSchedules.
  const TICK_MS = 60_000;
  const tick = async () => {
    try {
      for (const result of await fireDueSchedules()) {
        console.log(`[radulf] schedule ${result.scheduleId} ${result.outcome}: ${result.detail}`);
      }
    } catch (e) {
      console.error("[radulf] schedule tick failed:", e);
    }
  };
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), TICK_MS);
  }, TICK_MS - (Date.now() % TICK_MS));
}
