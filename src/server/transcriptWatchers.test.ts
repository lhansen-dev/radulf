import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-transcript-watchers-");

const { db, cards, repos, runs, iterations, events, now } = await import("@/db");
const { bus, emitEvent } = await import("./events");
const { runTranscriptDir } = await import("./retention");
const {
  startTranscriptWatchers,
  stopAllTranscriptWatchers,
  syncRunWatcher,
  syncTranscriptWatchers,
  watchedTranscripts,
} = await import("./transcriptWatchers");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("transcriptWatchers", () => {
  const callbacks = new Map<string, () => void>();
  let closeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stopAllTranscriptWatchers();
    db.delete(events).run();
    db.delete(iterations).run();
    db.delete(runs).run();
    db.delete(cards).run();
    db.delete(repos).run();
    db.insert(repos)
      .values({
        id: "repo-1",
        name: "Repo",
        path: path.join(os.tmpdir(), "repo-1"),
        defaultBranch: "main",
        createdAt: now(),
      })
      .run();
    db.insert(cards)
      .values({
        id: "card-1",
        repoId: "repo-1",
        title: "Card",
        description: "",
        status: "looping",
        position: 1,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    callbacks.clear();
    closeSpy = vi.fn();
    vi.spyOn(fs, "watch").mockImplementation(((p: string, cb: () => void) => {
      callbacks.set(p, cb);
      return { close: closeSpy } as unknown as fs.FSWatcher;
    }) as typeof fs.watch);
  });

  afterEach(() => {
    stopAllTranscriptWatchers();
    vi.restoreAllMocks();
  });

  function seedRun(id: string, kind: "plan" | "loop" | "evaluate", status: "running" | "completed" = "running") {
    db.insert(runs)
      .values({
        id,
        cardId: "card-1",
        kind,
        status,
        worktreePath: path.join(os.tmpdir(), "wt"),
        branch: "ralph/x",
        startedAt: now(),
      })
      .run();
    fs.mkdirSync(runTranscriptDir(id), { recursive: true });
  }

  it("starts exactly one watcher per running run and pushes each line once", async () => {
    seedRun("run-plan", "plan");
    const line = JSON.stringify({ t: "text", role: "assistant", content: "hello" });
    fs.writeFileSync(path.join(runTranscriptDir("run-plan"), "plan.jsonl"), `${line}\n`);
    const onPush = vi.fn();
    bus.on("transcript", onPush);
    try {
      syncTranscriptWatchers();
      syncTranscriptWatchers();
      expect(watchedTranscripts()).toEqual([{ runId: "run-plan", iteration: 0 }]);
      await sleep(100);
      expect(onPush).toHaveBeenCalledTimes(1);
      expect(onPush.mock.calls[0][0]).toMatchObject({
        runId: "run-plan",
        iteration: 0,
        lines: [{ t: "text", role: "assistant", content: "hello" }],
      });
    } finally {
      bus.off("transcript", onPush);
    }
  });

  it("does not watch a completed run", () => {
    seedRun("run-done", "plan", "completed");
    syncTranscriptWatchers();
    expect(watchedTranscripts()).toEqual([]);
  });

  it("follows a loop run's latest iteration, closing the previous watcher", () => {
    seedRun("run-loop", "loop");
    syncTranscriptWatchers();
    expect(watchedTranscripts()).toEqual([]);

    db.insert(iterations)
      .values({
        runId: "run-loop",
        n: 1,
        transcriptPath: path.join(runTranscriptDir("run-loop"), "iter-001.jsonl"),
        startedAt: now(),
      })
      .run();
    syncRunWatcher("run-loop");
    expect(watchedTranscripts()).toEqual([{ runId: "run-loop", iteration: 1 }]);

    db.insert(iterations)
      .values({
        runId: "run-loop",
        n: 2,
        transcriptPath: path.join(runTranscriptDir("run-loop"), "iter-002.jsonl"),
        startedAt: now(),
      })
      .run();
    syncRunWatcher("run-loop");
    expect(watchedTranscripts()).toEqual([{ runId: "run-loop", iteration: 2 }]);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("reacts to bus events and reconciles against the runs table", () => {
    const stop = startTranscriptWatchers(60_000);
    try {
      seedRun("run-evt", "plan");
      emitEvent("run.started", { cardId: "card-1", runId: "run-evt" });
      expect(watchedTranscripts()).toEqual([{ runId: "run-evt", iteration: 0 }]);

      emitEvent("run.finished", { cardId: "card-1", runId: "run-evt", payload: {} });
      expect(watchedTranscripts()).toEqual([]);

      syncRunWatcher("run-evt");
      expect(watchedTranscripts()).toEqual([{ runId: "run-evt", iteration: 0 }]);
      db.update(runs).set({ status: "completed" }).where(eq(runs.id, "run-evt")).run();
      syncTranscriptWatchers();
      expect(watchedTranscripts()).toEqual([]);
    } finally {
      stop();
    }
    expect(watchedTranscripts()).toEqual([]);
  });
});
