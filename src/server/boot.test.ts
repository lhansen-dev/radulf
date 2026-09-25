import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { sandboxEnabled: false } as { sandboxEnabled: boolean },
  pump: vi.fn(),
  ensureAuthSecret: vi.fn(),
  getSettings: vi.fn(),
  initializeSandboxRuntimeOnce: vi.fn(),
  getOrchestrator: vi.fn(),
  resumeImprovementRuns: vi.fn(),
  registerShutdownHandlers: vi.fn(),
  pruneRuntimeHistory: vi.fn(),
  claimDailySweep: vi.fn(),
  fireDueSchedules: vi.fn(),
  startEventsTail: vi.fn(),
  startTranscriptWatchers: vi.fn(),
}));

vi.mock("./authSecret", () => ({ ensureAuthSecret: mocks.ensureAuthSecret }));
vi.mock("./settings", () => ({ getSettings: mocks.getSettings }));
vi.mock("./sandbox/srt", () => ({
  initializeSandboxRuntimeOnce: mocks.initializeSandboxRuntimeOnce,
}));
vi.mock("./orchestrator", () => ({ getOrchestrator: mocks.getOrchestrator }));
vi.mock("./improvementRuns", () => ({ resumeImprovementRuns: mocks.resumeImprovementRuns }));
vi.mock("./shutdown", () => ({ registerShutdownHandlers: mocks.registerShutdownHandlers }));
vi.mock("./retention", () => ({
  pruneRuntimeHistory: mocks.pruneRuntimeHistory,
  claimDailySweep: mocks.claimDailySweep,
  removeFinishedWorktrees: async () => 0,
}));
vi.mock("./schedules", () => ({ fireDueSchedules: mocks.fireDueSchedules }));
vi.mock("./eventsTail", () => ({ startEventsTail: mocks.startEventsTail }));
vi.mock("./transcriptWatchers", () => ({
  startTranscriptWatchers: mocks.startTranscriptWatchers,
}));

const { boot } = await import("./boot");

function orchestratorStub() {
  return { pump: mocks.pump, startDraining: vi.fn(), hasInFlightWork: () => false };
}

function installDefaults() {
  mocks.getSettings.mockImplementation(() => mocks.settings);
  mocks.getOrchestrator.mockImplementation(orchestratorStub);
  mocks.initializeSandboxRuntimeOnce.mockResolvedValue({ ok: true, errors: [], warnings: [] });
  mocks.pruneRuntimeHistory.mockResolvedValue({});
  mocks.fireDueSchedules.mockResolvedValue([]);
}

const originalPumpInterval = process.env.RADULF_PUMP_INTERVAL_MS;

describe("boot", () => {
  beforeEach(() => {
    mocks.claimDailySweep.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalPumpInterval === undefined) delete process.env.RADULF_PUMP_INTERVAL_MS;
    else process.env.RADULF_PUMP_INTERVAL_MS = originalPumpInterval;
    mocks.settings = { sandboxEnabled: false };
    vi.clearAllMocks();
  });

  it("web-only: secret + settings, nothing from the worker half", async () => {
    installDefaults();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await boot(new Set(["web"]));

    expect(mocks.ensureAuthSecret).toHaveBeenCalledTimes(1);
    expect(mocks.getSettings).toHaveBeenCalledTimes(1);
    expect(mocks.startEventsTail).toHaveBeenCalledTimes(1);
    expect(mocks.startTranscriptWatchers).toHaveBeenCalledTimes(1);
    expect(mocks.getOrchestrator).not.toHaveBeenCalled();
    expect(mocks.resumeImprovementRuns).not.toHaveBeenCalled();
    expect(mocks.registerShutdownHandlers).not.toHaveBeenCalled();
    expect(mocks.initializeSandboxRuntimeOnce).not.toHaveBeenCalled();
  });

  it("worker: builds the orchestrator, wires shutdown, and polls the queue", async () => {
    vi.useFakeTimers();
    process.env.RADULF_PUMP_INTERVAL_MS = "1000";
    installDefaults();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await boot(new Set(["worker"]));

    expect(mocks.getOrchestrator).toHaveBeenCalledTimes(1);
    expect(mocks.resumeImprovementRuns).toHaveBeenCalledTimes(1);
    expect(mocks.startEventsTail).toHaveBeenCalledTimes(1);
    expect(mocks.startTranscriptWatchers).not.toHaveBeenCalled();
    const orchestrator = mocks.getOrchestrator.mock.results[0]!.value;
    expect(mocks.registerShutdownHandlers).toHaveBeenCalledWith(orchestrator);

    expect(mocks.pump).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_500);
    expect(mocks.pump.mock.calls.length).toBeGreaterThanOrEqual(2);
    // One boot call plus at least two pump ticks at the 1000 ms interval:
    // the worker adopts improvement runs a web-only process created.
    expect(mocks.resumeImprovementRuns.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("both roles with sandboxEnabled: runs the sandbox preflight once", async () => {
    vi.useFakeTimers();
    mocks.settings = { sandboxEnabled: true };
    installDefaults();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await boot(new Set(["web", "worker"]));

    expect(mocks.initializeSandboxRuntimeOnce).toHaveBeenCalledTimes(1);
    expect(mocks.getOrchestrator).toHaveBeenCalledTimes(1);
    expect(mocks.startEventsTail).toHaveBeenCalledTimes(1);
    expect(mocks.startTranscriptWatchers).toHaveBeenCalledTimes(1);
  });
});
