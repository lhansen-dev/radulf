import { describe, expect, it } from "vitest";
import { setupTestStateDir } from "@/testUtils/testDataDir";

setupTestStateDir("radulf-repo-route-");

const { db, repos, now } = await import("@/db");
const { PATCH } = await import("./route");

db.insert(repos).values({ id: "repo-1", name: "Repo", path: "/tmp/repo-route", defaultBranch: "main", createdAt: now() }).run();

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/repos/repo-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "repo-1" }) },
  );
}

describe("PATCH /api/repos/[id] gate command (spec 27)", () => {
  it("sets a trimmed gate command", async () => {
    const response = await patch({ gateCommand: "  make check " });
    expect(response.status).toBe(200);
    expect((await response.json()).gateCommand).toBe("make check");
    expect(db.select().from(repos).get()!.gateCommand).toBe("make check");
  });

  it("clears it with a blank string or null", async () => {
    expect((await (await patch({ gateCommand: "   " })).json()).gateCommand).toBeNull();
    await patch({ gateCommand: "make test" });
    expect((await (await patch({ gateCommand: null })).json()).gateCommand).toBeNull();
  });

  it("rejects a gate command that is not a string", async () => {
    const response = await patch({ gateCommand: 5 });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/gateCommand must be a string/);
  });

  it("still reports nothing to update when no known field is given", async () => {
    const response = await patch({ colour: "blue" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/nothing to update/);
  });
});
