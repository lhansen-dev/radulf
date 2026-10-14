import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeTraceManifests } from "./sanitize-next-traces.mjs";

let root;
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("sanitizeTraceManifests", () => {
  it("drops runtime state and secrets from trace manifests and keeps the rest", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-traces-"));
    const manifestDir = path.join(root, ".next", "server", "app");
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifest = path.join(manifestDir, "page.js.nft.json");
    const up = "../../../";
    fs.writeFileSync(manifest, JSON.stringify({
      version: 1,
      files: [
        `${up}src/app/page.tsx`,
        `${up}data/auth-secret`,
        `${up}data/pi-agent/auth.json`,
        `${up}plans/run-1/PLAN.md`,
        `${up}repos/private-repo/secret.ts`,
        `${up}worktrees/card-1/x.ts`,
        `${up}.env.local`,
        `${up}benchmarks/reports/run.json`,
      ],
    }));

    expect(sanitizeTraceManifests(root)).toBe(7);
    expect(JSON.parse(fs.readFileSync(manifest, "utf8")).files).toEqual([`${up}src/app/page.tsx`]);
  });
});
