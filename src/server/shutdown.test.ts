import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerShutdownHandlers } from "./shutdown";

type OrchestratorStub = {
  startDraining: () => void;
  hasInFlightWork: () => boolean;
  releaseOwnedWork: () => { runs: number; deliveries: number };
};

// The signal listeners the surrounding process (vitest, Node itself) installed
// before this file ran. afterEach() removes everything registerShutdownHandlers
// added and nothing else, so the suite never silences a handler it does not own.
let sigtermListeners: (() => void)[] = [];
let sigintListeners: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  sigtermListeners = process.listeners("SIGTERM") as unknown as (() => void)[];
  sigintListeners = process.listeners("SIGINT") as unknown as (() => void)[];
  // process.exit must not kill the test worker; the drain loop's microtasks
  // still need to run afterwards to assert on the ordering.
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const listener of process.listeners("SIGTERM")) {
    if (!sigtermListeners.includes(listener as unknown as () => void)) {
      process.removeListener("SIGTERM", listener);
    }
  }
  for (const listener of process.listeners("SIGINT")) {
    if (!sigintListeners.includes(listener as unknown as () => void)) {
      process.removeListener("SIGINT", listener);
    }
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Register the handlers and hand back the SIGTERM listener they installed. */
function install(orchestrator: OrchestratorStub): () => void {
  const before = new Set(process.listeners("SIGTERM"));
  registerShutdownHandlers(orchestrator);
  const added = process.listeners("SIGTERM").filter((listener) => !before.has(listener));
  if (added.length !== 1) throw new Error(`expected exactly one new SIGTERM listener, got ${added.length}`);
  return added[0] as unknown as () => void;
}

function stub(inFlight: () => boolean) {
  return {
    startDraining: vi.fn<() => void>(),
    hasInFlightWork: vi.fn<() => boolean>(inFlight),
    releaseOwnedWork: vi.fn<() => { runs: number; deliveries: number }>(() => ({ runs: 1, deliveries: 0 })),
  };
}

describe("registerShutdownHandlers", () => {
  it("clean path releases owned work before exiting", async () => {
    const o = stub(() => false);

    install(o)();
    await vi.advanceTimersByTimeAsync(0);

    expect(o.startDraining).toHaveBeenCalledTimes(1);
    expect(o.releaseOwnedWork).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(o.releaseOwnedWork.mock.invocationCallOrder[0]).toBeLessThan(
      (process.exit as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0],
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("interrupted 1 run and 0 deliveries owned by this worker"),
    );
  });

  it("timeout path still releases owned work after the drain gives up", async () => {
    const o = stub(() => true);

    install(o)();
    await vi.advanceTimersByTimeAsync(1_000);

    // Still inside the 30 s drain window: the run is never interrupted early.
    expect(o.releaseOwnedWork).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(o.releaseOwnedWork).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});