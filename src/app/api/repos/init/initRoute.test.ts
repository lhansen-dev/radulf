import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-init-route-");

const { db, repos } = await import("@/db");
const { patchSettings } = await import("@/server/settings");
const { POST } = await import("./route");

let root: string;

function post(body: unknown) {
  return new Request("http://localhost/api/repos/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "radulf-init-parent-")));
  patchSettings({ folderBrowserRoot: root });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /api/repos/init", () => {
  it("creates the repository and registers it", async () => {
    const response = await POST(post({ parentPath: root, name: "fresh-project" }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      name: "fresh-project",
      path: path.join(root, "fresh-project"),
      defaultBranch: "main",
    });
    expect(db.select().from(repos).all()).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "fresh-project", ".git"))).toBe(true);
  });

  it("refuses to create the same repository twice", async () => {
    const response = await POST(post({ parentPath: root, name: "fresh-project" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already exists/);
    expect(db.select().from(repos).all()).toHaveLength(1);
  });

  it("refuses a parent outside the browsable root", async () => {
    const response = await POST(post({ parentPath: os.tmpdir(), name: "escapee" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/outside the browsable root/);
  });

  it("requires a name and a parent folder", async () => {
    expect((await POST(post({ parentPath: root }))).status).toBe(400);
    expect((await POST(post({ name: "x" }))).status).toBe(400);
  });
});
