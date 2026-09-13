import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { pathRootsForRole, type AgentRole } from "./pi";
import { createGuardedFsTools } from "./guardedTools";

/**
 * Spec 14 Phase 3 acceptance: the "malicious test card" driven against the
 * REAL pi built-in file tools through the REAL guard on a hostile filesystem —
 * a worktree with a planted symlink, a prefix-sharing `-evil` sibling, an
 * outside secret, and a `~/.ssh` key. Every escape must fail at L2, visibly;
 * every legitimate in-root operation must delegate to the built-in for real.
 * No LLM and no server: L2 containment lives entirely in these in-process
 * tools, so this exercises the whole layer end-to-end.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l2accept-"));
const wt = path.join(tmp, "wt");
const evil = path.join(tmp, "wt-evil"); // sibling that shares the string prefix
const home = path.join(tmp, "home");
fs.mkdirSync(path.join(wt, "src"), { recursive: true });
fs.mkdirSync(path.join(wt, ".ralph"), { recursive: true });
fs.mkdirSync(evil, { recursive: true });
fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
fs.writeFileSync(path.join(wt, "src", "app.ts"), "export const x = 1;\n");
fs.writeFileSync(path.join(evil, "loot.ts"), "stolen");
const secret = path.join(tmp, "secret.env");
fs.writeFileSync(secret, "API_KEY=supersecret");
fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");
fs.symlinkSync(secret, path.join(wt, "escape-link")); // symlink inside wt → secret

const realHome = process.env.HOME;
process.env.HOME = home; // so ~ expands into the hostile fake home
afterAll(() => {
  process.env.HOME = realHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Build the guarded tools exactly as createRalphSession does for a role.
function toolFor(role: AgentRole, name: string): ToolDefinition {
  const { readRoots, writeRoots } = pathRootsForRole(role, wt);
  const t = createGuardedFsTools(wt, readRoots, writeRoots).find((d) => d.name === name);
  if (!t) throw new Error(`no guarded tool ${name}`);
  return t;
}
// pi's built-in file tools ignore ctx/onUpdate; a bare object suffices.
const run = (t: ToolDefinition, params: unknown) =>
  t.execute("id", params as never, undefined, undefined, {} as never);
const BOUNDARY = /path escapes this run's boundary/;

it("wraps exactly pi's six file tools, keeping their built-in names", () => {
  const { readRoots, writeRoots } = pathRootsForRole("loop", wt);
  expect(createGuardedFsTools(wt, readRoots, writeRoots).map((t) => t.name).sort()).toEqual([
    "edit",
    "find",
    "grep",
    "ls",
    "read",
    "write",
  ]);
});

describe("L2 acceptance — planner (read checkout, write .ralph only, no bash)", () => {
  it("allows reading source anywhere in the checkout", async () => {
    await expect(run(toolFor("planner", "read"), { path: "src/app.ts" })).resolves.toBeDefined();
  });
  it("allows writing a .ralph artifact and the delegate really writes it", async () => {
    await run(toolFor("planner", "write"), { path: ".ralph/PLAN.md", content: "plan" });
    expect(fs.existsSync(path.join(wt, ".ralph", "PLAN.md"))).toBe(true);
  });
  it("blocks writing a source file (write root is .ralph only)", async () => {
    await expect(
      run(toolFor("planner", "write"), { path: "src/app.ts", content: "pwn" }),
    ).rejects.toThrow(BOUNDARY);
    expect(fs.readFileSync(path.join(wt, "src", "app.ts"), "utf8")).toContain("const x = 1");
  });
  it("blocks editing any repo file", async () => {
    await expect(
      run(toolFor("planner", "edit"), {
        path: "src/app.ts",
        edits: [{ oldText: "1", newText: "2" }],
      }),
    ).rejects.toThrow(BOUNDARY);
  });
  it("blocks reading an outside path, a symlink to it, and ~/.ssh keys", async () => {
    await expect(run(toolFor("planner", "read"), { path: secret })).rejects.toThrow(BOUNDARY);
    await expect(run(toolFor("planner", "read"), { path: "escape-link" })).rejects.toThrow(BOUNDARY);
    await expect(
      run(toolFor("planner", "read"), { path: "~/.ssh/id_ed25519" }),
    ).rejects.toThrow(BOUNDARY);
  });
});

describe.each(["loop", "evaluator"] as const)(
  "L2 acceptance — %s (read+write worktree)",
  (role) => {
    it("allows reading, writing, and editing inside the worktree (delegate runs)", async () => {
      await expect(run(toolFor(role, "read"), { path: "src/app.ts" })).resolves.toBeDefined();
      await run(toolFor(role, "write"), { path: `src/gen-${role}.ts`, content: "ok" });
      expect(fs.existsSync(path.join(wt, "src", `gen-${role}.ts`))).toBe(true);
      await expect(
        run(toolFor(role, "edit"), {
          path: `src/gen-${role}.ts`,
          edits: [{ oldText: "ok", newText: "done" }],
        }),
      ).resolves.toBeDefined();
    });
    it("blocks writes and edits into the prefix-sharing -evil sibling (segment-safe)", async () => {
      await expect(
        run(toolFor(role, "write"), { path: "../wt-evil/loot.ts", content: "pwn" }),
      ).rejects.toThrow(BOUNDARY);
      await expect(
        run(toolFor(role, "edit"), {
          path: path.join(evil, "loot.ts"),
          edits: [{ oldText: "stolen", newText: "pwn" }],
        }),
      ).rejects.toThrow(BOUNDARY);
      expect(fs.readFileSync(path.join(evil, "loot.ts"), "utf8")).toBe("stolen");
    });
    it("blocks reads outside the worktree and through the planted symlink", async () => {
      await expect(run(toolFor(role, "read"), { path: secret })).rejects.toThrow(BOUNDARY);
      await expect(run(toolFor(role, "read"), { path: "escape-link" })).rejects.toThrow(BOUNDARY);
    });
    it("blocks grep/find rooted outside the worktree, allows the default (cwd)", async () => {
      await expect(run(toolFor(role, "grep"), { pattern: "KEY", path: tmp })).rejects.toThrow(BOUNDARY);
      await expect(run(toolFor(role, "find"), { pattern: "*", path: tmp })).rejects.toThrow(BOUNDARY);
      await expect(run(toolFor(role, "ls"), {})).resolves.toBeDefined();
    });
  },
);

it("the outside secret is never mutated by any blocked write across the whole run", () => {
  expect(fs.readFileSync(secret, "utf8")).toBe("API_KEY=supersecret");
});
