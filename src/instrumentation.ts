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
    getOrchestrator();

    // recover() (inside getOrchestrator()) has already flipped any orphaned
    // card to needs_attention, so it's safe to reattach improvement-run
    // drivers now.
    const { resumeImprovementRuns } = await import("@/server/improvementRuns");
    resumeImprovementRuns();
  }
}
