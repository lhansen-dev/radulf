import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insideRadulfSandbox } from "@/testUtils/insideRadulfSandbox";

// DATA_DIR is resolved at import time, so everything that reaches @/db is
// imported only after this. A tmpdir outside $HOME also covers the case where
// $HOME's read deny does not already hide the run's private root.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-seatbelt-"));
process.env.RADULF_DATA_DIR = path.join(testDataDir, "data");
const { testSettings } = await import("@/testUtils/testSettings");
const { createRunSandbox } = await import("./context");
const { createSandboxedBashOperations, initializeSandboxRuntimeOnce } = await import("./srt");

const execFileAsync = promisify(execFile);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform !== "darwin" || insideRadulfSandbox)(
  "Seatbelt run reaper (macOS process-tree supervisor)",
  () => {
    let repoDir: string;

    beforeAll(async () => {
      await initializeSandboxRuntimeOnce();
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-seatbelt-repo-"));
      await execFileAsync("git", ["-C", repoDir, "init"]);
    });

    afterAll(() => {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(testDataDir, { recursive: true, force: true });
      delete process.env.RADULF_DATA_DIR;
    });

    async function startRun(runId: string) {
      const ctx = await createRunSandbox(runId, {
        cwd: repoDir,
        s: testSettings({ sandboxEnabled: true }),
      });
      const ops = createSandboxedBashOperations(ctx.srtConfig!, {
        tmpdir: ctx.tmpdir,
        runExclusive: ctx.runExclusive,
        tracker: ctx,
      });
      const bash = async (command: string) => {
        const chunks: Buffer[] = [];
        const { exitCode } = await ops.exec(command, repoDir, {
          onData: (d) => chunks.push(d),
        });
        return { exitCode, output: Buffer.concat(chunks).toString() };
      };
      return { ctx, bash };
    }

    /** Background a sleep in its own process group (job control), so it
     * outlives its shell and escapes process-group reaping. */
    async function escapeProcessGroup(
      bash: (command: string) => Promise<{ exitCode: number | null }>,
      tmpdir: string,
    ): Promise<number> {
      const pidFile = path.join(tmpdir, "escaped.pid");
      await bash(`set -m; sleep 600 >/dev/null 2>&1 & echo $! > ${pidFile}`);
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(alive(pid)).toBe(true);
      return pid;
    }

    it("lets the run read its marker but never read the negative or delete either", async () => {
      const { ctx, bash } = await startRun("seatbelt-markers");
      const marker = path.join(ctx.root, "process-marker");
      const negative = path.join(ctx.root, "process-negative");
      try {
        expect((await bash(`cat ${marker}`)).exitCode).toBe(0);
        expect((await bash(`cat ${negative}`)).exitCode).not.toBe(0);
        await bash(`rm -f ${marker} ${negative}`);
        expect(fs.existsSync(marker)).toBe(true);
        expect(fs.existsSync(negative)).toBe(true);
        // The run-private TMPDIR stays usable inside the read-denied root.
        expect((await bash(`echo ok > "$TMPDIR/f" && cat "$TMPDIR/f"`)).output).toBe("ok\n");
      } finally {
        await ctx.cleanup();
      }
    }, 30_000);

    it("kills a process that left the run's process group, and only this run's processes", async () => {
      const first = await startRun("seatbelt-reap-a");
      const second = await startRun("seatbelt-reap-b");
      const bystander = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
      try {
        const escaped = await escapeProcessGroup(first.bash, first.ctx.tmpdir);
        const neighbour = await escapeProcessGroup(second.bash, second.ctx.tmpdir);

        await expect(first.ctx.reap()).resolves.toEqual([]);
        expect(alive(escaped)).toBe(false);
        expect(alive(neighbour)).toBe(true);
        expect(alive(bystander.pid!)).toBe(true);

        await expect(second.ctx.reap()).resolves.toEqual([]);
        expect(alive(neighbour)).toBe(false);
      } finally {
        bystander.kill("SIGKILL");
        await first.ctx.cleanup();
        await second.ctx.cleanup();
      }
    }, 30_000);

    it("fails closed when the marker it identifies the run by is gone", async () => {
      const { ctx, bash } = await startRun("seatbelt-missing-marker");
      try {
        await bash("true");
        fs.rmSync(path.join(ctx.root, "process-marker"));
        await expect(ctx.reap()).rejects.toThrow(/cannot prove command quiescence: .*marker is missing/);
      } finally {
        await ctx.cleanup();
      }
    }, 30_000);
  },
);
