// Four-process check: two web-only `next start` processes and two worker-only
// `dist/worker.mjs` processes boot together against one fresh data directory
// and race on migrations and auth-secret creation; events and live transcripts
// must fan out from a worker to a web process that never executed anything, and
// the two workers must share one queue through database claims. This
// spawns real servers (and needs the production build), so it runs only from
// `make check-split` (RADULF_SPLIT_CHECK=1), never on a plain `make test`.
//
// Deliberately never imports `@/db`: the child processes own the
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
let port2: number;
let baseUrl2: string;
let web: ChildProcess;
let web2: ChildProcess;
let worker: ChildProcess;
let worker2: ChildProcess;
// Set by the SIGKILL test so afterAll and the SIGTERM test skip the corpse.
let killedPid: number | null = null;
const out = { web: "", web2: "", worker: "", worker2: "" };
// Shared between the fan-out test and the drive test.
let repoId: string;
let cardId: string;

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
    `timed out after ${timeoutMs}ms waiting for ${what}\n--- web ---\n${tail(out.web)}\n--- web2 ---\n${tail(out.web2)}\n--- worker ---\n${tail(out.worker)}\n--- worker2 ---\n${tail(out.worker2)}`,
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

// Subscribes to an SSE endpoint and collects every `data:` frame as parsed
// JSON. `ready` resolves once the response headers arrived (the subscription
// is live), so frames emitted after awaiting it cannot be missed.
function openEventStream(url: string): {
  frames: Array<Record<string, unknown>>;
  ready: Promise<void>;
  close: () => void;
} {
  const frames: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const ready = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`event stream ${url} responded ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split("\n")) {
              if (line.startsWith("data: ")) {
                frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
              }
            }
          }
        }
      } catch {
        // aborted by close()
      }
    })();
  })();
  return { frames, ready, close: () => controller.abort() };
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

    if (!fs.existsSync(path.join(repoRoot, ".next", "BUILD_ID"))) {
      throw new Error("run `make build` first (make check-split depends on it)");
    }
    execFileSync("make", ["build-worker"], { cwd: repoRoot, stdio: "inherit" });

    port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    port2 = await freePort();
    baseUrl2 = `http://127.0.0.1:${port2}`;

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
      "RADULF_EVENTS_TAIL_INTERVAL_MS",
      "RADULF_TRANSCRIPT_SCAN_INTERVAL_MS",
      "RADULF_CONTROL_POLL_INTERVAL_MS",
    ]) {
      delete base[key];
    }
    // Fast fan-out so cross-process assertions do not wait on the defaults.
    // Both at their floors (eventsTailIntervalMs / transcriptScanIntervalMs):
    // the mock provider drives a whole loop run in a few hundred milliseconds,
    // so web2 must notice `iteration.started` and attach its transcript
    // watcher well before `run.finished` lands or it sees no live pushes.
    const fanOut = {
      RADULF_EVENTS_TAIL_INTERVAL_MS: "50",
      RADULF_TRANSCRIPT_SCAN_INTERVAL_MS: "100",
    };

    // Spawned back to back so they race on the empty directory.
    //
    // Web: deliberately WITHOUT RADULF_MOCK_LLM — if this process ever ran a
    // stage, the mock provider would refuse and the card would land in Needs
    // Attention instead of In Review, so a role leak shows up in the outcome.
    // `detached: true` makes it a process-group leader so killing -pid also
    // reaches any server child that `next start` forks.
    const webEnv = {
      ...base,
      ...fanOut,
      RADULF_ROLES: "web",
      RADULF_DATA_DIR: dataDir,
      RADULF_AUTH_PASSWORD_HASH: "",
      NEXT_TELEMETRY_DISABLED: "1",
      PI_OFFLINE: "1",
    };
    const spawnWeb = (p: number) =>
      spawn(
        path.join(repoRoot, "node_modules/.bin/next"),
        ["start", "-H", "127.0.0.1", "-p", String(p)],
        { cwd: repoRoot, detached: true, stdio: ["ignore", "pipe", "pipe"], env: webEnv },
      );
    web = spawnWeb(port);
    web2 = spawnWeb(port2);
    // Workers: NODE_ENV=test skips the 2 GiB disk-watchdog ballast; PI_OFFLINE=1
    // skips pi's model-catalog fetch. Two identical workers share the one
    // database so claims, the cap, and the stale reaper are exercised across
    // processes. A 1s heartbeat keeps the stale window (set to 15s below)
    // meaningful within the test's budget.
    const workerEnv: NodeJS.ProcessEnv = {
      ...base,
      ...fanOut,
      RADULF_ROLES: "worker",
      RADULF_DATA_DIR: dataDir,
      RADULF_MOCK_LLM: "1",
      PI_OFFLINE: "1",
      NODE_ENV: "test",
      RADULF_PUMP_INTERVAL_MS: "500",
      RADULF_HEARTBEAT_INTERVAL_MS: "1000",
      // Fast control poll so the cross-process cancel below lands within a
      // couple of polls instead of waiting on the default.
      RADULF_CONTROL_POLL_INTERVAL_MS: "200",
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
    pipe(web2, "web2");
    pipe(worker, "worker");
    pipe(worker2, "worker2");

    await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, 120_000, "web /api/health");
    await waitFor(
      async () => (await fetch(`${baseUrl2}/api/health`)).ok,
      120_000,
      "web2 /api/health",
    );
  }, 150_000);

  async function killWeb(child: ChildProcess | undefined) {
    if (!child) return;
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      // already gone
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }

  afterAll(async () => {
    for (const { child } of aliveWorkers()) child.kill("SIGKILL");
    await Promise.all([killWeb(web), killWeb(web2)]);
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

    expect(out.web + out.web2 + out.worker + out.worker2).not.toMatch(
      /SQLITE_BUSY|database is locked|EEXIST|already exists/,
    );
  });

  it(
    "fans a card created on one web process out to the other web process's event stream",
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
      repoId = (repo.json as { id: string }).id;

      // Subscribe on web2 BEFORE creating the card on web1: the only way the
      // frame can reach web2 is through the events tailer.
      const stream = openEventStream(baseUrl2 + "/api/events/stream");
      await stream.ready;
      try {
        const card = await api("POST", "/api/cards", {
          repoId,
          title: "Split check",
          description: "Driven by the mock provider.",
          plannerModel: "happy-path",
          loopModel: "happy-path",
          evaluatorModel: "happy-path",
        });
        expect(card.status).toBe(201);
        cardId = (card.json as { id: string }).id;

        await waitFor(
          () => stream.frames.some((f) => f.type === "card.created" && f.cardId === cardId),
          5_000,
          "card.created on the second web process",
        );
      } finally {
        stream.close();
      }
    },
    30_000,
  );

  it(
    "drives a card from Todo to In Review through the web-only process",
    async () => {
      expect(repoId).toBeTruthy();
      expect(cardId).toBeTruthy();

      expect((await api("POST", `/api/cards/${cardId}/move`, { to: "todo" })).status).toBe(200);
      // Three worker pump intervals: a web-only process queues but never
      // plans, and with autoMode off the worker leaves an unstarted Todo card
      // alone, so nothing may have run yet.
      await new Promise((r) => setTimeout(r, 1_500));
      const listed = await api("GET", "/api/cards");
      expect(listed.status).toBe(200);
      const queued = (listed.json as Array<{ id: string }>).find((c) => c.id === cardId);
      expect(queued).toMatchObject({ status: "todo", latestRun: null });

      // Subscribe on web2 (which never executes anything) before the run
      // starts so every live transcript push for the loop run is captured.
      const stream = openEventStream(baseUrl2 + "/api/events/stream");
      await stream.ready;

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
          id: string;
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

      // Live transcript pushes reached web2 even though the worker wrote the
      // files: web2's watcher registry tails every running run it sees.
      const loopRunId = ofKind("loop")[0].id;
      const pushes = stream.frames.filter(
        (f) => f.kind === "transcript" && f.runId === loopRunId,
      ) as unknown as Array<{
        iteration: number;
        fromCursor: number;
        cursor: number;
        lines: unknown[];
      }>;
      expect(pushes.length).toBeGreaterThan(0);

      // Gapless and duplicate-free per iteration.
      const byIteration = new Map<number, typeof pushes>();
      for (const p of pushes) {
        const group = byIteration.get(p.iteration) ?? [];
        group.push(p);
        byIteration.set(p.iteration, group);
      }
      for (const group of byIteration.values()) {
        expect(group[0].fromCursor).toBe(0);
        for (let i = 1; i < group.length; i++) {
          expect(group[i].fromCursor).toBe(group[i - 1].cursor);
        }
      }

      // Pushes concatenate to a prefix of the full transcript as served by
      // web2, and a reconnecting client resuming from its last cursor gets
      // exactly the remainder.
      const busiest = [...byIteration.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      const [iteration, group] = busiest;
      type Chunk = { lines: unknown[]; cursor: number; hasMore: boolean };
      const drain = async (start: number): Promise<unknown[]> => {
        const lines: unknown[] = [];
        let cursor = start;
        for (;;) {
          const res = await fetch(
            `${baseUrl2}/api/runs/${loopRunId}?iteration=${iteration}&cursor=${cursor}`,
          );
          expect(res.status).toBe(200);
          const chunk = (await res.json()) as Chunk;
          lines.push(...chunk.lines);
          if (!chunk.hasMore) break;
          cursor = chunk.cursor;
        }
        return lines;
      };
      const full = await drain(0);
      const pushed = group.flatMap((p) => p.lines);
      expect(full.slice(0, pushed.length)).toEqual(pushed);
      const rest = await drain(group.at(-1)!.cursor);
      expect([...pushed, ...rest]).toEqual(full);
      stream.close();

      // The web processes ran without RADULF_MOCK_LLM, so reaching review
      // proves every pi session ran in the worker.
      expect(out.web).not.toMatch(/mock provider is disabled/);
      expect(out.web2).not.toMatch(/mock provider is disabled/);
    },
    150_000,
  );

  it(
    "cancelling a looping card from the web-only process ends the run in the worker",
    async () => {
      const repos = await api<Array<{ id: string; name: string }>>("GET", "/api/repos");
      expect(repos.status).toBe(200);
      const repoId = repos.json.find((r) => r.name === "fixture")!.id;

      // The stall scenario hangs the mock stream until aborted, so this run
      // can only end through the worker consuming the control signal.
      const card = await api<{ id: string }>("POST", "/api/cards", {
        repoId,
        title: "Cancelled mid-loop",
        description: "Its loop stalls until the owning worker aborts it.",
        plannerModel: "happy-path",
        loopModel: "stall",
        evaluatorModel: "happy-path",
      });
      expect(card.status).toBe(201);
      const cardId = card.json.id;
      expect((await api("POST", `/api/cards/${cardId}/move`, { to: "todo" })).status).toBe(200);
      expect((await api("POST", `/api/cards/${cardId}/move`, { to: "in_progress" })).status).toBe(
        200,
      );

      type LoopRow = { id: string };
      let running: LoopRow | undefined;
      const deadline = Date.now() + 90_000;
      while (!running) {
        [running] = dbQuery<LoopRow>(
          "SELECT id FROM runs WHERE kind = 'loop' AND status = 'running' AND worker_id IS NOT NULL AND card_id = ?",
          cardId,
        );
        if (running) break;
        if (Date.now() > deadline) {
          throw new Error(
            `no claimed running loop run for the card\n--- worker ---\n${tail(out.worker)}\n--- worker2 ---\n${tail(out.worker2)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      const runId = running.id;

      // The first `iterations` row is written after the worker registers its
      // AbortController and right before it starts the harness, so from here on
      // the cancel must travel through the worker's `runs.control` poll.
      await waitFor(
        () => dbQuery<{ id: string }>("SELECT id FROM iterations WHERE run_id = ?", runId).length > 0,
        60_000,
        "the loop's first iteration to start",
      );

      // The web process moves the card at once without waiting on the worker.
      expect((await api("POST", `/api/cards/${cardId}/move`, { to: "backlog" })).status).toBe(
        200,
      );
      const moved = await api<{ card?: { status?: string } }>("GET", `/api/cards/${cardId}`);
      expect(moved.json.card?.status).toBe("backlog");

      // The owning worker polls runs.control, aborts, and clears the signal.
      type RunRow = {
        status: string;
        exit_reason: string | null;
        control: string | null;
        ended_at: string | null;
      };
      let run: RunRow | undefined;
      await waitFor(
        () => {
          [run] = dbQuery<RunRow>(
            "SELECT status, exit_reason, control, ended_at FROM runs WHERE id = ?",
            runId,
          );
          return run?.status === "cancelled" && run.control === null;
        },
        5_000,
        "the worker to cancel the stalled run and consume the control signal",
      );
      expect(run!.exit_reason).toBe("cancelled by user");
      expect(run!.ended_at).not.toBeNull();

      const finished = dbQuery<{ payload: string }>(
        "SELECT payload FROM events WHERE run_id = ? AND type = 'run.finished'",
        runId,
      );
      expect(finished).toHaveLength(1);
      expect(JSON.parse(finished[0].payload)).toMatchObject({ status: "cancelled" });

      const iterations = dbQuery<{ status: string }>(
        "SELECT status FROM iterations WHERE run_id = ?",
        runId,
      );
      for (const row of iterations) expect(row.status).toBe("failed");

      // The worker's cleanup removed the run's scratch directory.
      const scratch = path.join(root, "runtmp");
      await waitFor(
        () =>
          !fs.existsSync(scratch) ||
          fs.readdirSync(scratch).every((name) => !name.startsWith(runId)),
        10_000,
        "the cancelled run's scratch directory to be removed",
      );
    },
    120_000,
  );

  it(
    "pausing a looping card from the web-only process pauses it at the iteration boundary and resume starts a new claimed run",
    async () => {
      const repos = await api<Array<{ id: string; name: string }>>("GET", "/api/repos");
      expect(repos.status).toBe(200);
      const repoId = repos.json.find((r) => r.name === "fixture")!.id;

      // The phantom scenario runs three short no-progress iterations and then
      // fails as stalled, so the run ends on its own if pause never lands.
      const card = await api<{ id: string }>("POST", "/api/cards", {
        repoId,
        title: "Paused mid-loop",
        description: "Paused from the web process, resumed onto a fresh run.",
        plannerModel: "happy-path",
        loopModel: "phantom",
        evaluatorModel: "happy-path",
      });
      expect(card.status).toBe(201);
      const cardId = card.json.id;
      expect((await api("POST", `/api/cards/${cardId}/move`, { to: "todo" })).status).toBe(200);
      expect((await api("POST", `/api/cards/${cardId}/move`, { to: "in_progress" })).status).toBe(
        200,
      );

      const deadline = Date.now() + 90_000;
      for (;;) {
        const [row] = dbQuery<{ status: string }>(
          "SELECT status FROM cards WHERE id = ?",
          cardId,
        );
        if (row?.status === "looping") break;
        if (Date.now() > deadline) {
          throw new Error(
            `card never reached looping (last: ${row?.status})\n--- worker ---\n${tail(out.worker)}\n--- worker2 ---\n${tail(out.worker2)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      // The web process pauses the card at once; the worker pauses the run
      // at the next iteration boundary.
      expect((await api("POST", `/api/cards/${cardId}/pause`)).status).toBe(200);
      const pausedCard = await api<{ card?: { status?: string } }>("GET", `/api/cards/${cardId}`);
      expect(pausedCard.json.card?.status).toBe("paused");

      type LoopRow = {
        id: string;
        status: string;
        exit_reason: string | null;
        control: string | null;
        worker_id: string | null;
      };
      const loopRuns = () =>
        dbQuery<LoopRow>(
          "SELECT id, status, exit_reason, control, worker_id FROM runs WHERE kind = 'loop' AND card_id = ? ORDER BY started_at",
          cardId,
        );
      let loops: LoopRow[] = [];
      await waitFor(
        () => {
          loops = loopRuns();
          return loops[0]?.status === "paused";
        },
        60_000,
        "the worker to pause the loop run",
      );
      expect(loops[0].exit_reason).toBe("paused by user");
      expect(loops[0].control).toBe("pause");

      // Resume starts a fresh run that a worker claims.
      expect((await api("POST", `/api/cards/${cardId}/resume`)).status).toBe(200);
      await waitFor(
        () => {
          loops = loopRuns();
          return loops.length === 2 && loops[1].worker_id !== null;
        },
        60_000,
        "a second claimed loop run after resume",
      );
      expect(loops).toHaveLength(2);
      expect(loops[1].worker_id).not.toBeNull();

      // Let the resumed run finish so nothing of this card is in flight when
      // the later tests assert every run has ended.
      await waitFor(
        async () => {
          const status = (await api<{ card?: { status?: string } }>("GET", `/api/cards/${cardId}`))
            .json.card?.status;
          return status === "needs_attention" || status === "review";
        },
        120_000,
        "the resumed card to settle",
      );
    },
    180_000,
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
