import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { pathBoundaryMessage } from "../sandbox/pathGuard";
import { createGuardedFsTools } from "./guardedTools";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guardedtools-"));
const worktree = path.join(tmp, "wt");
fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
fs.writeFileSync(path.join(worktree, "src", "a.ts"), "inside");
fs.writeFileSync(path.join(tmp, "secret.txt"), "outside");

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const tools = createGuardedFsTools(worktree, [worktree], [worktree]);
const byName = (name: string): ToolDefinition => {
  const t = tools.find((d) => d.name === name);
  if (!t) throw new Error(`no guarded tool named ${name}`);
  return t;
};
// pi's built-in file tools ignore ctx/onUpdate; a bare object suffices.
const call = (t: ToolDefinition, params: unknown) =>
  t.execute("id", params as never, undefined, undefined, {} as never);

describe("createGuardedFsTools — spec 14 Layer 2 wrappers", () => {
  it("wraps exactly the six file tools, keeping their built-in names", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });

  it("delegates to the built-in when the path is in-bounds (write creates it)", async () => {
    await call(byName("write"), {
      path: "src/created.ts",
      content: "hello",
    });
    expect(fs.readFileSync(path.join(worktree, "src", "created.ts"), "utf8")).toBe(
      "hello",
    );
  });

  it("blocks a write escaping the worktree before touching the filesystem", async () => {
    await expect(
      call(byName("write"), { path: "../secret.txt", content: "pwned" }),
    ).rejects.toThrow(pathBoundaryMessage([worktree]));
    // The delegate never ran: the outside file is untouched.
    expect(fs.readFileSync(path.join(tmp, "secret.txt"), "utf8")).toBe("outside");
  });

  it("blocks an edit escaping the worktree", async () => {
    await expect(
      call(byName("edit"), {
        path: path.join(tmp, "secret.txt"),
        edits: [{ oldText: "outside", newText: "pwned" }],
      }),
    ).rejects.toThrow(pathBoundaryMessage([worktree]));
    expect(fs.readFileSync(path.join(tmp, "secret.txt"), "utf8")).toBe("outside");
  });

  it("blocks a read escaping the worktree", async () => {
    await expect(
      call(byName("read"), { path: path.join(tmp, "secret.txt") }),
    ).rejects.toThrow(pathBoundaryMessage([worktree]));
  });

  it("allows a read inside the worktree", async () => {
    await expect(call(byName("read"), { path: "src/a.ts" })).resolves.toBeDefined();
  });

  it("allows grep/find/ls with no path (defaults to cwd, a root)", async () => {
    await expect(call(byName("ls"), {})).resolves.toBeDefined();
  });
});
