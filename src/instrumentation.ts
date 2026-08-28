export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureAuthSecret } = await import("@/server/authSecret");
    ensureAuthSecret();

    // Spec 14 Phase 6: startup preflight, not first-command discovery — a
    // sandboxEnabled run started before this resolves awaits the same
    // cached promise (initializeSandboxRuntimeOnce is memoized) and fails
    // loudly before its first iteration if this reports errors, rather
    // than discovering a broken sandbox mid-run.
    const { getSettings } = await import("@/server/settings");
    const { initializeSandboxRuntimeOnce } = await import("@/server/sandbox/srt");
    if (getSettings().sandboxEnabled) {
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

    const { getOrchestrator } = await import("@/server/orchestrator");
    const orchestrator = getOrchestrator();

    // recover() (inside getOrchestrator()) has already flipped any orphaned
    // card to needs_attention, so it's safe to reattach improvement-run
    // drivers now.
    const { resumeImprovementRuns } = await import("@/server/improvementRuns");
    resumeImprovementRuns();

    const { registerShutdownHandlers } = await import("@/server/shutdown");
    registerShutdownHandlers(orchestrator);

    // PLAN.md Phase 7: pruneRuntimeHistory previously only ran when a human
    // hit the manual /api/maintenance/cleanup endpoint, so transcripts and
    // events accumulated unbounded on every deploy that nobody visited that
    // endpoint on. Sweep automatically on a daily cadence, plus once shortly
    // after boot so a long-running dev/staging instance doesn't wait a full
    // day for its first cleanup. No Settings field for the window yet — 30
    // days is a hardcoded default; revisit if anyone asks for control over it.
    const { pruneRuntimeHistory } = await import("@/server/retention");
    const RETENTION_DAYS = 30;
    const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const RETENTION_INITIAL_DELAY_MS = 60_000;
    const runRetentionSweep = () => {
      try {
        const result = pruneRuntimeHistory(RETENTION_DAYS);
        console.log(`[radulf] retention sweep: ${JSON.stringify(result)}`);
      } catch (e) {
        console.error("[radulf] retention sweep failed:", e);
      }
    };
    setTimeout(runRetentionSweep, RETENTION_INITIAL_DELAY_MS);
    setInterval(runRetentionSweep, RETENTION_INTERVAL_MS);
  }
}
