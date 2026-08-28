// Bounded wait for an in-flight run to reach a terminal state before exiting.
// If it elapses with a run still active, exit anyway — recover() reconciles
// the DB on next boot exactly as it does for a hard crash today; the
// value-add here is only the common case (idle, or between iterations)
// exiting cleanly instead of relying on that crash-recovery path every time.
const SHUTDOWN_TIMEOUT_MS = 30_000;
const SHUTDOWN_POLL_MS = 500;

export function registerShutdownHandlers(orchestrator: {
  startDraining(): void;
  hasInFlightWork(): boolean;
}) {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    orchestrator.startDraining();
    console.log(`[radulf] received ${signal} — draining in-flight runs`);
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (orchestrator.hasInFlightWork() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS));
    }
    if (orchestrator.hasInFlightWork()) {
      console.log("[radulf] shutdown timeout elapsed with a run still active — exiting anyway");
    } else {
      console.log("[radulf] shutdown clean — exiting");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
