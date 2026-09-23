import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initScratchRepo } from "@/testUtils/gitRepo";
import { setupTestStateDir } from "@/testUtils/testDataDir";

const root = setupTestStateDir("radulf-repos-route-");

const { db, repos } = await import("@/db");
const { upsertSettingJson } = await import("@/db");
const { POST } = await import("./route");

/** Inside the browsable root the settings below point at. */
let inside: string;
/** A checkout on the host that the picker would never have offered. */
let outside: string;

function post(body: unknown) {
  return new Request("http://localhost/api/repos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  const browsable = path.join(root, "browsable");
  fs.mkdirSync(browsable, { recursive: true });
  upsertSettingJson("folderBrowserRoot", browsable);
  inside = initScratchRepo("radulf-repos-inside-");
  // initScratchRepo lands in the system temp dir; move it under the root.
  const moved = path.join(browsable, path.basename(inside));
  fs.renameSync(inside, moved);
  inside = moved;
  outside = initScratchRepo("radulf-repos-outside-");
});

afterAll(() => {
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("POST /api/repos", () => {
  it("registers a checkout inside the browsable root", async () => {
    const response = await POST(post({ name: "inside", path: inside }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ name: "inside", path: inside, defaultBranch: "main" });
    expect(db.select().from(repos).all()).toHaveLength(1);
  });

  it("refuses a path outside it", async () => {
    // The picker only ever offers paths inside the root, so a request naming
    // one outside it did not come from the picker.
    const response = await POST(post({ name: "outside", path: outside }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/outside the browsable root/);
    expect(db.select().from(repos).all()).toHaveLength(1);
  });

  it("stores a trimmed gate command when given one, and rejects a non-string (spec 27)", async () => {
    const another = initScratchRepo("radulf-repos-gated-");
    const moved = path.join(path.dirname(inside), path.basename(another));
    fs.renameSync(another, moved);

    const rejected = await POST(post({ name: "gated", path: moved, gateCommand: 5 }));
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toMatch(/gateCommand must be a string/);

    const response = await POST(post({ name: "gated", path: moved, gateCommand: "  make check " }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ name: "gated", gateCommand: "make check" });
  });
});
