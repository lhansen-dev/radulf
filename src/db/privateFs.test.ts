import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateDir, tighten } from "./privateFs";

const eperm = () => Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });

describe("privateFs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-private-"));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tolerates a chmod it may not make on a path that is already private", () => {
    // What a shared volume owned by another uid looks like: already 0700,
    // but the chmod itself is refused.
    const owned = path.join(dir, "owned");
    fs.mkdirSync(owned, { mode: 0o700 });
    fs.writeFileSync(path.join(owned, "f"), "x", { mode: 0o600 });
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw eperm();
    });
    expect(() => privateDir(owned)).not.toThrow();
    expect(() => tighten(path.join(owned, "f"))).not.toThrow();
  });

  it("fails closed when the refused path stays visible to other accounts", () => {
    const exposed = path.join(dir, "exposed");
    fs.mkdirSync(exposed);
    fs.chmodSync(exposed, 0o755);
    fs.writeFileSync(path.join(exposed, "f"), "x");
    fs.chmodSync(path.join(exposed, "f"), 0o644);
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw eperm();
    });
    expect(() => privateDir(exposed)).toThrow(/EPERM/);
    expect(() => tighten(path.join(exposed, "f"))).toThrow(/EPERM/);
  });

  it("creates a missing directory owner-only", () => {
    const fresh = path.join(dir, "a", "b");
    privateDir(fresh);
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o700);
  });
});
