import { sleep } from "@/shared/sleep";

// Bounded wait for in-flight work — a run this worker owns, or a review
// delivery (merge / push / PR of an approved card) this worker claimed — to
// reach a terminal state before exiting. Neither branch leaves a mess for the
// next boot to untangle: the common case (idle, or between iterations) simply
// exits clean, and if the window elapses with work still active we exit anyway
// *after* handing the work back. releaseOwnedWork() interrupts this worker's
// own runs and review deliveries, frees its repo leases and deletes its
// `workers` row, so a replacement worker picks the card up on its very next
// pump instead of waiting out the reaper — the timeout no longer relies on the
// crash-recovery path in recover().
//
// Only effective with NEXT_MANUAL_SIG_HANDLE=1 in the environment (the
// Makefile's `start` target and the Dockerfile set it): otherwise `next
// start` installs its own SIGTERM/SIGINT handler that exits with 143/130 as
// soon as open connections close, which is milliseconds when no browser tab
// or SSE stream is attached, and this drain never gets to run. That caveat
// applies only under `next start`: a plain Node worker process
// (src/worker.ts) installs these handlers directly and drains on SIGTERM
// as-is.
const SHUTDOWN_TIMEOUT_MS = 30_000;
const SHUTDOWN_POLL_MS = 500;

export function registerShutdownHandlers(orchestrator: {
  startDraining(): void;
  hasInFlightWork(): boolean;
  releaseOwnedWork(): { runs: number; deliveries: number };
}) {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    orchestrator.startDraining();
    console.log(`[radulf] received ${signal} — draining in-flight runs and review deliveries`);
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (orchestrator.hasInFlightWork() && Date.now() < deadline) {
      await sleep(SHUTDOWN_POLL_MS);
    }
    if (orchestrator.hasInFlightWork()) {
      console.log("[radulf] shutdown timeout elapsed with a run or review delivery still active — exiting anyway");
    } else {
      console.log("[radulf] shutdown clean — exiting");
    }
    // Both paths, right before exiting: a clean drain released its work through
    // the normal terminal transitions, so this reports (and cleans up) whatever
    // is still ours — the timed-out run/delivery, the repo leases and the
    // `workers` row that would otherwise make a peer wait workerStaleSeconds
    // for the heartbeat to age out. Best-effort: a DB failure here must not
    // keep the process alive past the drain window.
    try {
      const released = orchestrator.releaseOwnedWork();
      console.log(
        `[radulf] interrupted ${released.runs} ${released.runs === 1 ? "run" : "runs"} and ${released.deliveries} ${
          released.deliveries === 1 ? "delivery" : "deliveries"
        } owned by this worker`,
      );
    } catch (e) {
      console.error("[radulf] releasing this worker's runs, deliveries and leases failed:", e);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
