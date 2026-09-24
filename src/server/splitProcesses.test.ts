// Three-process check: two web-only `next start` processes and a worker-only
// `dist/worker.mjs` boot together against one fresh data directory and race on
// migrations and auth-secret creation; events and live transcripts must fan
// out from the worker to a web process that never executed anything. This
// spawns real servers (and needs the production build), so it runs only from
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
let port2: number;
let baseUrl2: string;
let web: ChildProcess;
let web2: ChildProcess;
let worker: ChildProcess;
const out = { web: "", web2: "", worker: "" };
// Shared between the fan-out test and the drive test.
let repoId: string;
let cardId: string;

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
    `timed out after ${timeoutMs}ms waiting for ${what}\n--- web ---\n${tail(out.web)}\n--- web2 ---\n${tail(out.web2)}\n--- worker ---\n${tail(out.worker)}`,
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
    // Worker: NODE_ENV=test skips the 2 GiB disk-watchdog ballast; PI_OFFLINE=1
    // skips pi's model-catalog fetch.
    worker = spawn(process.execPath, ["dist/worker.mjs"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...base,
        ...fanOut,
        RADULF_ROLES: "worker",
        RADULF_DATA_DIR: dataDir,
        RADULF_MOCK_LLM: "1",
        PI_OFFLINE: "1",
        NODE_ENV: "test",
        RADULF_PUMP_INTERVAL_MS: "500",
      },
    });
    pipe(web, "web");
    pipe(web2, "web2");
    pipe(worker, "worker");

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
    if (worker && worker.exitCode === null) worker.kill("SIGKILL");
    await Promise.all([killWeb(web), killWeb(web2)]);
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("both roles boot one fresh data directory at once", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.ok).toBe(true);
    // restartRequired: false means the web process sees migrations complete.
    expect(await res.json()).toMatchObject({ ok: true, roles: ["web"], restartRequired: false });

    await waitFor(
      () => out.worker.includes("[radulf] roles: worker"),
      30_000,
      "worker to log its roles",
    );
    expect(worker.exitCode).toBeNull();

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

    expect(out.web + out.web2 + out.worker).not.toMatch(/SQLITE_BUSY|database is locked|EEXIST|already exists/);
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
        throw new Error(`card landed in needs_attention\n--- worker ---\n${tail(out.worker)}`);
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

  it("SIGTERM drains the worker-only process", async () => {
    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker did not exit within 15s")), 15_000);
      worker.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    worker.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(out.worker).toContain("shutdown clean");
  });
});
