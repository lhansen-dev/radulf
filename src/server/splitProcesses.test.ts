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
const out = { web: "", worker: "" };

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
    `timed out after ${timeoutMs}ms waiting for ${what}\n--- web ---\n${tail(out.web)}\n--- worker ---\n${tail(out.worker)}`,
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
    // Worker: NODE_ENV=test skips the 2 GiB disk-watchdog ballast; PI_OFFLINE=1
    // skips pi's model-catalog fetch.
    worker = spawn(process.execPath, ["dist/worker.mjs"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...base,
        RADULF_ROLES: "worker",
        RADULF_DATA_DIR: dataDir,
        RADULF_MOCK_LLM: "1",
        PI_OFFLINE: "1",
        NODE_ENV: "test",
        RADULF_PUMP_INTERVAL_MS: "500",
      },
    });
    pipe(web, "web");
    pipe(worker, "worker");

    await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, 120_000, "web /api/health");
  }, 150_000);

  afterAll(async () => {
    if (worker && worker.exitCode === null) worker.kill("SIGKILL");
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

    expect(out.web + out.worker).not.toMatch(/SQLITE_BUSY|database is locked|EEXIST|already exists/);
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

      // The web process ran without RADULF_MOCK_LLM, so reaching review
      // proves every pi session ran in the worker.
      expect(out.web).not.toMatch(/mock provider is disabled/);
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
