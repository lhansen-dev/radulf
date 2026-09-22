import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import path from "node:path";

import { guardPath } from "../sandbox/pathGuard";

/**
 * Layer 2 (spec 14): thin wrappers around pi's built-in file tools that
 * guard-then-delegate. Each wrapper resolves the tool's path argument through
 * the shared guard (`pathGuard.ts`) against the role's allowed roots, then
 * calls the untouched built-in. Reusing pi's own definitions (schema,
 * rendering, execution) rather than reimplementing keeps the wrappers from
 * drifting when the SDK upgrades — the only added behavior is the guard.
 *
 * - **Read-side** (`read`/`grep`/`find`/`ls`): the path checks against read
 *   roots. `grep`/`find`/`ls` take an optional path defaulting to cwd (a root),
 *   so a missing path needs no check.
 * - **Mutating** (`write`/`edit`): the path checks against write roots, which
 *   are always a subset of the read roots, so no separate read check is needed
 *   for the edit tool's read-then-write. `<cwd>/.git` is carved out of every
 *   write root: in a linked worktree it is the file naming the gitdir, and a
 *   rewritten pointer redirects every host-side git call (L1 denies the same
 *   path to agent bash — see `buildFilesystemConfig`).
 */

type PathArgKind = "read" | "write";

/**
 * Wrap one built-in tool definition: guard the named path arguments, then
 * delegate to the original `execute`. The guard throws before `execute` runs,
 * so an escaping path never reaches the filesystem.
 */
function guard(
  def: ToolDefinition,
  argSpecs: { arg: string; kind: PathArgKind }[],
  readRoots: string[],
  writeRoots: string[],
  cwd: string,
): ToolDefinition {
  const delegate = def.execute.bind(def);
  const writeDenied = [path.join(cwd, ".git")];
  return {
    ...def,
    // async so a guard rejection surfaces as a rejected promise, not a
    // synchronous throw the caller must special-case.
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as Record<string, unknown>;
      for (const { arg, kind } of argSpecs) {
        const value = p[arg];
        if (typeof value === "string" && value.length > 0) {
          if (kind === "write") guardPath(value, writeRoots, cwd, writeDenied);
          else guardPath(value, readRoots, cwd);
        }
      }
      return delegate(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/**
 * The six path-guarded file tools for a role, built from pi's own definitions.
 * `createRalphSession` injects the subset the role's tool set names (via
 * `customTools`, overriding the built-ins by name — the same mechanism the
 * scrubbed bash tool uses).
 */
export function createGuardedFsTools(
  cwd: string,
  readRoots: string[],
  writeRoots: string[],
): ToolDefinition[] {
  // Cast through unknown: each factory returns a definition whose schema is
  // narrower than the generic ToolDefinition element type (renderCall
  // variance), which is safe here — same cast the scrubbed bash tool uses.
  const asDef = (d: unknown) => d as ToolDefinition;
  const g = (d: unknown, specs: { arg: string; kind: PathArgKind }[]) =>
    guard(asDef(d), specs, readRoots, writeRoots, cwd);

  return [
    g(createReadToolDefinition(cwd), [{ arg: "path", kind: "read" }]),
    g(createWriteToolDefinition(cwd), [{ arg: "path", kind: "write" }]),
    g(createEditToolDefinition(cwd), [{ arg: "path", kind: "write" }]),
    g(createGrepToolDefinition(cwd), [{ arg: "path", kind: "read" }]),
    g(createFindToolDefinition(cwd), [{ arg: "path", kind: "read" }]),
    g(createLsToolDefinition(cwd), [{ arg: "path", kind: "read" }]),
  ];
}
