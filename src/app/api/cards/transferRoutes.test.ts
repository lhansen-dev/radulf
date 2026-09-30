import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initScratchRepo } from "@/testUtils/gitRepo";
import { setupTestDataDir } from "@/testUtils/testDataDir";

vi.mock("@/server/orchestrator", () => ({ getOrchestrator: () => ({ pump: () => {} }) }));

setupTestDataDir("radulf-transfer-routes-");

const { db, cards, repos, scopingMessages, now } = await import("@/db");
const { GET: EXPORT } = await import("./export/route");
const { POST: IMPORT } = await import("./import/route");

let repo: string;

beforeAll(() => {
  repo = initScratchRepo("radulf-transfer-routes-repo-");
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  db.delete(scopingMessages).run();
  db.delete(cards).run();
  db.delete(repos).run();
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo one", path: repo, defaultBranch: "main", createdAt: now() })
    .run();
  db.insert(cards)
    .values({
      id: "card-1",
      repoId: "repo-1",
      title: "Lock login after five failures",
      description: "## Problem\nBrute force.",
      status: "backlog",
      position: 1,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
});

const importRequest = (body: unknown) =>
  new Request("http://localhost/api/cards/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /api/cards/export", () => {
  it("answers with a named attachment so a browser saves it", async () => {
    const response = await EXPORT(new Request("http://localhost/api/cards/export?cardId=card-1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition"))
      .toMatch(/^attachment; filename="radulf-repo-one-card-\d{4}-\d{2}-\d{2}\.json"$/);
    const body = await response.json();
    expect(body.version).toBe(1);
    expect(body.cards[0].title).toBe("Lock login after five failures");
  });

  it("400s without a selector, and 404s on a card that is gone", async () => {
    expect((await EXPORT(new Request("http://localhost/api/cards/export"))).status).toBe(400);
    expect((await EXPORT(new Request("http://localhost/api/cards/export?cardId=nope"))).status).toBe(404);
  });
});

describe("POST /api/cards/import", () => {
  it("creates the file's cards in the repo the request names", async () => {
    const file = await (await EXPORT(new Request("http://localhost/api/cards/export?repoId=repo-1"))).json();
    db.delete(cards).run();

    const response = await IMPORT(importRequest({ ...file, repoId: "repo-1" }));

    expect(response.status).toBe(201);
    const { cardIds, notes } = await response.json();
    expect(cardIds).toHaveLength(1);
    expect(notes).toEqual([]);
    expect(db.select().from(cards).all()[0]).toMatchObject({ repoId: "repo-1", status: "backlog" });
  });

  it("insists on a repoId, because the file's own is another install's", async () => {
    const file = await (await EXPORT(new Request("http://localhost/api/cards/export?cardId=card-1"))).json();

    const response = await IMPORT(importRequest(file));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/repoId is required/);
  });

  it("returns the reason a file was refused", async () => {
    const response = await IMPORT(importRequest({ repoId: "repo-1", version: 99, cards: [{ title: "x" }] }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/version 99/);
  });
});
