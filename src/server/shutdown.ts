import { sleep } from "@/shared/sleep";

// Bounded wait for an in-flight run to reach a terminal state before exiting.
// If it elapses with a run still active, exit anyway — recover() reconciles
// the DB on next boot exactly as it does for a hard crash today; the
// value-add here is only the common case (idle, or between iterations)
// exiting cleanly instead of relying on that crash-recovery path every time.
//
// Only effective with NEXT_MANUAL_SIG_HANDLE=1 in the environment (the
// Makefile's `start` target and the Dockerfile set it): otherwise `next
// start` installs its own SIGTERM/SIGINT handler that exits with 143/130 as
// soon as open connections close, which is milliseconds when no browser tab
// or SSE stream is attached, and this drain never gets to run.
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
      await sleep(SHUTDOWN_POLL_MS);
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
