import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initScratchRepo } from "@/testUtils/gitRepo";
import { setupTestStateDir } from "@/testUtils/testDataDir";

const root = setupTestStateDir("radulf-clone-route-");

const { db, repos } = await import("@/db");
const { POST } = await import("./route");

let source: string;

function post(body: unknown) {
  return new Request("http://localhost/api/repos/clone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  source = initScratchRepo("radulf-clone-route-src-");
});

afterAll(() => {
  fs.rmSync(source, { recursive: true, force: true });
});

describe("POST /api/repos/clone", () => {
  it("clones the repository into repos/ and registers it", async () => {
    const response = await POST(post({ url: `file://${source}` }));

    expect(response.status).toBe(201);
    const name = path.basename(source);
    expect(await response.json()).toMatchObject({
      name,
      path: path.join(root, "repos", name),
      defaultBranch: "main",
    });
    expect(db.select().from(repos).all()).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "repos", name, ".git"))).toBe(true);
  });

  it("refuses to clone the same repository twice", async () => {
    const response = await POST(post({ url: `file://${source}` }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already exists/);
    expect(db.select().from(repos).all()).toHaveLength(1);
  });

  it("requires a url and rejects a bare path", async () => {
    expect((await POST(post({}))).status).toBe(400);
    const response = await POST(post({ url: source }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/clone URL/);
  });
});
