import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

// Reached only through the scheduler's own deps, which nothing here fires.
vi.mock("@/server/orchestrator", () => ({ getOrchestrator: () => ({ startCard: () => {} }) }));

setupTestDataDir("radulf-schedules-routes-");

const { db, repos, schedules, now } = await import("@/db");
const { GET, POST } = await import("./route");
const { PATCH, DELETE } = await import("./[id]/route");

function post(body: unknown) {
  return new Request("http://localhost/api/schedules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(body: unknown) {
  return new Request("http://localhost/api/schedules/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  db.delete(schedules).run();
  db.delete(repos).run();
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo", path: "/tmp/repo-1", defaultBranch: "main", createdAt: now() })
    .run();
});

describe("/api/schedules", () => {
  it("creates a schedule and lists it with its upcoming fire times", async () => {
    const created = await POST(post({ kind: "queue-drain", cron: "0 3 * * *" }));
    expect(created.status).toBe(201);

    const listed = await (await GET()).json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ kind: "queue-drain", repoId: null, cron: "0 3 * * *", enabled: 1 });
    expect(listed[0].upcoming).toHaveLength(3);
  });

  it("returns the service's own reason for refusing a body", async () => {
    const bad = await POST(post({ kind: "queue-drain", cron: "0 3 * *" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/five fields/);

    const wrongKind = await POST(post({ kind: "deploy", cron: "0 3 * * *" }));
    expect(wrongKind.status).toBe(400);
    expect((await wrongKind.json()).error).toMatch(/kind must be one of/);

    const noRepo = await POST(post({ kind: "improvement-run", cron: "0 3 * * *" }));
    expect(noRepo.status).toBe(400);
    expect((await noRepo.json()).error).toMatch(/needs a repoId/);
  });

  it("suspends and deletes by id, and 404s on one that is gone", async () => {
    const { id } = await (await POST(post({ kind: "queue-drain", cron: "0 3 * * *" }))).json();

    const suspended = await PATCH(patch({ enabled: false }), ctx(id));
    expect((await suspended.json()).enabled).toBe(0);

    expect((await DELETE(new Request("http://localhost", { method: "DELETE" }), ctx(id))).status).toBe(200);
    expect(await (await GET()).json()).toEqual([]);
    expect((await PATCH(patch({ enabled: true }), ctx(id))).status).toBe(404);
  });

  it("keeps an improvement-run schedule's arguments through an edit of its cron", async () => {
    const { id } = await (
      await POST(
        post({
          kind: "improvement-run",
          repoId: "repo-1",
          cron: "0 2 * * *",
          config: { baseBranch: "beta", budgetMinutes: 90, focusPrompt: "tests" },
        }),
      )
    ).json();

    const edited = await (await PATCH(patch({ cron: "0 4 * * 1-5" }), ctx(id))).json();

    expect(edited.cron).toBe("0 4 * * 1-5");
    expect(JSON.parse(edited.config)).toEqual({ baseBranch: "beta", budgetMinutes: 90, focusPrompt: "tests" });
  });
});
