// Two-process check: a web-only `next dev` and a worker-only `dist/worker.mjs`
// boot together against one fresh data directory and race on migrations and
// auth-secret creation. This spawns real servers, so it runs only from
// `make check-split` (RADULF_SPLIT_CHECK=1), never on a plain `make test`.
//
// Deliberately never imports `@/db`: the two child processes own the
// database. This test speaks HTTP with fetch and reads files.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const repoRoot = process.cwd();

let root: string;
let dataDir: string;
let port: number;
let baseUrl: string;
let web: ChildProcess;
let worker: ChildProcess;
let worker2: ChildProcess;
// Set by the SIGKILL test so afterAll and the SIGTERM test skip the corpse.
let killedPid: number | null = null;
const out = { web: "", worker: "", worker2: "" };

function aliveWorkers(): Array<{ child: ChildProcess; key: "worker" | "worker2" }> {
  return ([
    { child: worker, key: "worker" as const },
    { child: worker2, key: "worker2" as const },
  ]).filter(({ child }) => child && child.pid !== killedPid && child.exitCode === null);
}

function openDb(): InstanceType<typeof Database> {
  return new Database(path.join(dataDir, "radulf.db"), { readonly: true });
}

function dbQuery<T>(sql: string, ...params: unknown[]): T[] {
  const db = openDb();
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function tail(s: string): string {
  return s.slice(-2000);
}

// Polls until `condition` holds; a thrown error (e.g. ECONNREFUSED while the
// server is still starting) counts as "not yet" rather than a failure.
async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${what}\n--- web ---\n${tail(out.web)}\n--- worker ---\n${tail(out.worker)}\n--- worker2 ---\n${tail(out.worker2)}`,
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        srv.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port: p } = address;
      srv.close(() => resolve(p));
    });
  });
}

// JSON round-trip against the web process. No `Origin` header, so the CSRF
// check in src/proxy.ts passes; auth is off because RADULF_AUTH_PASSWORD_HASH
// is empty in the web child's environment.
async function api<T = unknown>(
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await fetch(baseUrl + route, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

function pipe(child: ChildProcess, key: keyof typeof out) {
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      out[key] += chunk;
    });
  }
}

describe.skipIf(process.env.RADULF_SPLIT_CHECK !== "1")("split web/worker processes", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-split-"));
    // Not created on purpose: both processes must find it absent and race on
    // creating the directory, the DB, and the auth secret.
    dataDir = path.join(root, "data");

    execFileSync("make", ["build-worker"], { cwd: repoRoot, stdio: "inherit" });

    port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;

    // Strip anything from the developer's shell or .env.local that would make
    // the two children share state or change the behaviour under test.
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      "NODE_ENV",
      "RADULF_MOCK_LLM",
      "RADULF_AUTH_SECRET",
      "RADULF_ROLES",
      "RADULF_WORKTREES_DIR",
      "RADULF_PLANS_DIR",
      "RADULF_PUMP_INTERVAL_MS",
    ]) {
      delete base[key];
    }

    // Spawned back to back so they race on the empty directory.
    //
    // Web: deliberately WITHOUT RADULF_MOCK_LLM — if this process ever ran a
    // stage, the mock provider would refuse and the card would land in Needs
    // Attention instead of In Review, so a role leak shows up in the outcome.
    // `detached: true` makes it a process-group leader so killing -pid also
    // reaches the server child that `next dev` forks.
    web = spawn(
      path.join(repoRoot, "node_modules/.bin/next"),
      ["dev", "-H", "127.0.0.1", "-p", String(port)],
      {
        cwd: repoRoot,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...base,
          RADULF_ROLES: "web",
          RADULF_DATA_DIR: dataDir,
          RADULF_AUTH_PASSWORD_HASH: "",
          NEXT_TELEMETRY_DISABLED: "1",
          PI_OFFLINE: "1",
        },
      },
    );
    // Workers: NODE_ENV=test skips the 2 GiB disk-watchdog ballast; PI_OFFLINE=1
    // skips pi's model-catalog fetch. Two identical workers share the one
    // database so claims, the cap, and the stale reaper are exercised across
    // processes. A 1s heartbeat keeps the stale window (set to 15s below)
    // meaningful within the test's budget.
    const workerEnv: NodeJS.ProcessEnv = {
      ...base,
      RADULF_ROLES: "worker",
      RADULF_DATA_DIR: dataDir,
      RADULF_MOCK_LLM: "1",
      PI_OFFLINE: "1",
      NODE_ENV: "test",
      RADULF_PUMP_INTERVAL_MS: "500",
      RADULF_HEARTBEAT_INTERVAL_MS: "1000",
    };
    worker = spawn(process.execPath, ["dist/worker.mjs"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: workerEnv,
    });
    worker2 = spawn(process.execPath, ["dist/worker.mjs"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: workerEnv,
    });
    pipe(web, "web");
    pipe(worker, "worker");
    pipe(worker2, "worker2");

    await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, 120_000, "web /api/health");
  }, 150_000);

  afterAll(async () => {
    for (const { child } of aliveWorkers()) child.kill("SIGKILL");
    if (web) {
      try {
        process.kill(-web.pid!, "SIGTERM");
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) => {
        if (web.exitCode !== null) return resolve();
        const timer = setTimeout(resolve, 5_000);
        web.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      try {
        process.kill(-web.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("both roles boot one fresh data directory at once", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.ok).toBe(true);
    // restartRequired: false means the web process sees migrations complete.
    expect(await res.json()).toMatchObject({ ok: true, roles: ["web"], restartRequired: false });

    await waitFor(
      () =>
        out.worker.includes("[radulf] roles: worker") &&
        out.worker2.includes("[radulf] roles: worker"),
      30_000,
      "both workers to log their roles",
    );
    expect(worker.exitCode).toBeNull();
    expect(worker2.exitCode).toBeNull();

    // Each worker process registered exactly one row for itself.
    await waitFor(
      () => dbQuery<{ roles: string }>("SELECT roles FROM workers").length === 2,
      15_000,
      "two rows in the workers table",
    );
    const workerRows = dbQuery<{ roles: string; pid: number }>("SELECT roles, pid FROM workers");
    expect(workerRows).toHaveLength(2);
    for (const row of workerRows) expect(JSON.parse(row.roles)).toEqual(["worker"]);
    expect(new Set(workerRows.map((r) => r.pid))).toEqual(new Set([worker.pid, worker2.pid]));

    expect(fs.readFileSync(path.join(dataDir, "auth-secret"), "utf8").trim()).toMatch(
      /^[0-9a-f]{64}$/,
    );

    // One fully migrated database, nothing applied twice.
    const journal = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    const db = new Database(path.join(dataDir, "radulf.db"), { readonly: true });
    try {
      const row = db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number };
      expect(row.n).toBe(journal.entries.length);
    } finally {
      db.close();
    }

    expect(out.web + out.worker + out.worker2).not.toMatch(
      /SQLITE_BUSY|database is locked|EEXIST|already exists/,
    );
  });

  it(
    "drives a card from Todo to In Review through the web-only process",
    async () => {
      const repoPath = path.join(root, "repos", "fixture");
      fs.mkdirSync(repoPath, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "pipe" });
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Split Check");
      git("config", "user.email", "split@radulf.local");
      fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
      git("add", ".");
      git("commit", "-q", "-m", "initial");

      const settings = await api("PATCH", "/api/settings", {
        plannerProvider: "mock",
        loopProvider: "mock",
        evaluatorProvider: "mock",
        plannerModel: "",
        loopModel: "",
        evaluatorModel: "",
        autoMode: false,
        sandboxEnabled: false,
        folderBrowserRoot: root,
        maxConcurrentCards: 1,
        workerStaleSeconds: 15,
      });
      expect(settings.status).toBe(200);

      const repo = await api("POST", "/api/repos", {
        name: "fixture",
        path: repoPath,
        defaultBranch: "main",
      });
      expect(repo.status).toBe(201);
      const repoId = (repo.json as { id: string }).id;

      const card = await api("POST", "/api/cards", {
        repoId,
        title: "Split check",
        description: "Driven by the mock provider.",
        plannerModel: "happy-path",
        loopModel: "happy-path",
        evaluatorModel: "happy-path",
      });
      expect(card.status).toBe(201);
      const cardId = (card.json as { id: string }).id;

      expect((await api("POST", `/api/cards/${cardId}/move`, { to: "todo" })).status).toBe(200);
      // Three worker pump intervals: a web-only process queues but never
      // plans, and with autoMode off the worker leaves an unstarted Todo card
      // alone, so nothing may have run yet.
      await new Promise((r) => setTimeout(r, 1_500));
      const listed = await api("GET", "/api/cards");
      expect(listed.status).toBe(200);
      const queued = (listed.json as Array<{ id: string }>).find((c) => c.id === cardId);
      expect(queued).toMatchObject({ status: "todo", latestRun: null });

      // The passive web orchestrator only stamps startedAt; the worker's
      // timer pump picks the card up from there.
      expect((await api("POST", `/api/cards/${cardId}/move`, { to: "in_progress" })).status).toBe(
        200,
      );

      // waitFor treats a thrown condition as "not yet", so a terminal
      // needs_attention ends the poll via the flag and fails at once below
      // instead of burning the full timeout.
      type CardDetail = {
        card?: { status?: string };
        runs: Array<{
          kind: string;
          status: string;
          iterationsDone: number | null;
          exitReason: string | null;
        }>;
      };
      let detail: CardDetail | undefined;
      let failed = false;
      await waitFor(
        async () => {
          detail = (await api<CardDetail>("GET", `/api/cards/${cardId}`)).json;
          const status = detail.card?.status;
          if (status === "needs_attention") failed = true;
          return failed || status === "review";
        },
        120_000,
        "card to reach review",
      );
      if (failed) {
        throw new Error(
          `card landed in needs_attention\n--- worker ---\n${tail(out.worker)}\n--- worker2 ---\n${tail(out.worker2)}`,
        );
      }

      const runs = detail!.runs;
      const ofKind = (kind: string) => runs.filter((r) => r.kind === kind);
      expect(ofKind("plan")).toHaveLength(1);
      expect(ofKind("loop")).toHaveLength(1);
      expect(ofKind("evaluate")).toHaveLength(1);
      expect(ofKind("plan")[0]).toMatchObject({ status: "completed" });
      expect(ofKind("loop")[0]).toMatchObject({
        status: "completed",
        iterationsDone: 2,
        exitReason: "done-signal",
      });
      expect(ofKind("evaluate")[0]).toMatchObject({ status: "completed", exitReason: "approve" });

      // The web process ran without RADULF_MOCK_LLM, so reaching review
      // proves every pi session ran in the worker.
      expect(out.web).not.toMatch(/mock provider is disabled/);
    },
    150_000,
  );

  it(
    "two workers never run two runs of one repo at once with a cap of one",
    async () => {
      const repos = await api<Array<{ id: string; name: string }>>("GET", "/api/repos");
      expect(repos.status).toBe(200);
      const repoId = repos.json.find((r) => r.name === "fixture")!.id;

      const cardIds: string[] = [];
      for (const n of [1, 2, 3]) {
        const card = await api<{ id: string }>("POST", "/api/cards", {
          repoId,
          title: `Contention ${n}`,
          description: "Three cards racing two workers for one repo slot.",
          plannerModel: "happy-path",
          loopModel: "happy-path",
          evaluatorModel: "happy-path",
        });
        expect(card.status).toBe(201);
        cardIds.push(card.json.id);
      }
      for (const id of cardIds) {
        expect((await api("POST", `/api/cards/${id}/move`, { to: "todo" })).status).toBe(200);
        expect((await api("POST", `/api/cards/${id}/move`, { to: "in_progress" })).status).toBe(
          200,
        );
      }

      type CardRow = { id: string; status: string };
      let maxRunning = 0;
      let failed: CardRow | undefined;
      const deadline = Date.now() + 240_000;
      for (;;) {
        const [running] = dbQuery<{ n: number }>(
          "SELECT count(*) AS n FROM runs WHERE status = 'running'",
        );
        if (running.n > maxRunning) maxRunning = running.n;

        let statuses: CardRow[] = [];
        try {
          statuses = (await api<CardRow[]>("GET", "/api/cards")).json.filter((c) =>
            cardIds.includes(c.id),
          );
        } catch {
          // web momentarily unreachable: not yet
        }
        failed = statuses.find((c) => c.status === "needs_attention");
        if (failed) break;
        if (statuses.length === 3 && statuses.every((c) => c.status === "review")) break;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for the three contention cards to reach review: ${JSON.stringify(statuses)}\n--- worker ---\n${tail(out.worker)}\n--- worker2 ---\n${tail(out.worker2)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      if (failed) {
        throw new Error(
          `card ${failed.id} landed in needs_attention\n--- worker ---\n${tail(out.worker)}\n--- worker2 ---\n${tail(out.worker2)}`,
        );
      }

      // The cap is per repo across processes: the sampled peak is one, and
      // the recorded intervals are disjoint (ISO timestamps sort as strings).
      expect(maxRunning).toBeLessThanOrEqual(1);
      const intervals = dbQuery<{
        started_at: string;
        ended_at: string | null;
        worker_id: string | null;
      }>("SELECT started_at, ended_at, worker_id FROM runs ORDER BY started_at");
      expect(intervals.length).toBeGreaterThan(0);
      for (let i = 1; i < intervals.length; i++) {
        const prev = intervals[i - 1];
        const next = intervals[i];
        expect(prev.ended_at).not.toBeNull();
        expect(prev.ended_at! <= next.started_at).toBe(true);
      }
      for (const row of intervals) expect(row.worker_id).not.toBeNull();
    },
    260_000,
  );

  it(
    "SIGKILL on a worker mid-loop hands the card to the other worker within the stale window",
    async () => {
      const repos = await api<Array<{ id: string; name: string }>>("GET", "/api/repos");
      const repoId = repos.json.find((r) => r.name === "fixture")!.id;
      const card = await api<{ id: string }>("POST", "/api/cards", {
        repoId,
        title: "Killed mid-loop",
        description: "Its worker dies after the first iteration.",
        plannerModel: "happy-path",
        loopModel: "happy-path",
        evaluatorModel: "happy-path",
      });
      expect(card.status).toBe(201);
      const cardId = card.json.id;
      expect((await api("POST", `/api/cards/${cardId}/move`, { to: "todo" })).status).toBe(200);
      expect((await api("POST", `/api/cards/${cardId}/move`, { to: "in_progress" })).status).toBe(
        200,
      );

      type LoopRow = { id: string; worker_id: string | null; iterations_done: number };
      let victim: LoopRow | undefined;
      const deadline = Date.now() + 120_000;
      while (!victim) {
        [victim] = dbQuery<LoopRow>(
          "SELECT id, worker_id, iterations_done FROM runs WHERE kind = 'loop' AND status = 'running' AND iterations_done >= 1 AND card_id = ?",
          cardId,
        );
        if (victim) break;
        if (Date.now() > deadline) {
          throw new Error(
            `no running loop run with a finished iteration for the card\n--- worker ---\n${tail(out.worker)}\n--- worker2 ---\n${tail(out.worker2)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(victim.worker_id).not.toBeNull();
      const [ownerRow] = dbQuery<{ pid: number }>(
        "SELECT pid FROM workers WHERE id = ?",
        victim.worker_id,
      );
      expect(ownerRow).toBeDefined();
      const pid = ownerRow.pid;
      expect([worker.pid, worker2.pid]).toContain(pid);
      killedPid = pid;
      process.kill(pid, "SIGKILL");
      const survivor = aliveWorkers();
      expect(survivor).toHaveLength(1);

      let failed = false;
      await waitFor(
        async () => {
          const detail = (await api<{ card?: { status?: string } }>("GET", `/api/cards/${cardId}`))
            .json;
          const status = detail.card?.status;
          if (status === "needs_attention") failed = true;
          return failed || status === "review";
        },
        60_000,
        "the killed card to reach review on the other worker",
      );
      if (failed) {
        throw new Error(
          `card landed in needs_attention after the kill\n--- worker ---\n${tail(out.worker)}\n--- worker2 ---\n${tail(out.worker2)}`,
        );
      }

      type RunRow = {
        id: string;
        status: string;
        worker_id: string | null;
        iterations_done: number;
        worktree_path: string;
      };
      const loops = dbQuery<RunRow>(
        "SELECT id, status, worker_id, iterations_done, worktree_path FROM runs WHERE kind = 'loop' AND card_id = ? ORDER BY started_at",
        cardId,
      );
      expect(loops).toHaveLength(2);
      const interrupted = loops.find((r) => r.id === victim!.id)!;
      const finisher = loops.find((r) => r.id !== victim!.id)!;
      expect(interrupted.status).toBe("interrupted");
      expect(finisher.status).toBe("completed");
      expect(finisher.worker_id).not.toBeNull();
      expect(finisher.worker_id).not.toBe(victim.worker_id);
      const [survivorRow] = dbQuery<{ id: string }>(
        "SELECT id FROM workers WHERE pid = ?",
        survivor[0].child.pid,
      );
      expect(finisher.worker_id).toBe(survivorRow.id);
      expect(interrupted.iterations_done).toBeGreaterThanOrEqual(1);
      // 2 normally; 3 only when the kill landed after an iteration completed
      // but before its bookkeeping tick, so the finisher redid that task.
      expect([2, 3]).toContain(interrupted.iterations_done + finisher.iterations_done);
      expect(fs.existsSync(path.join(finisher.worktree_path, "mock-output/task-1.md"))).toBe(true);
      expect(fs.existsSync(path.join(finisher.worktree_path, "mock-output/task-2.md"))).toBe(true);

      // The reaper dropped the dead worker's row.
      expect(dbQuery("SELECT id FROM workers WHERE pid = ?", pid)).toHaveLength(0);
      expect(out[survivor[0].key]).not.toMatch(/SQLITE_BUSY/);
    },
    200_000,
  );

  it("SIGTERM drains the worker-only process", async () => {
    const alive = aliveWorkers();
    expect(alive).toHaveLength(1);
    const { child, key } = alive[0];
    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${key} did not exit within 15s`)), 15_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(out[key]).toContain("shutdown clean");
  });
});
