import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { git, initScratchRepo } from "@/testUtils/gitRepo";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-card-transfer-");

const { db, cards, events, repos, scopingMessages, now } = await import("@/db");
const { exportCards, exportFileName, importCards, parseCardExport } = await import("./cardTransfer");

let source: string;
let target: string;

beforeAll(() => {
  source = initScratchRepo("radulf-transfer-source-");
  git(source, "branch", "release/2");
  target = initScratchRepo("radulf-transfer-target-");
});

afterAll(() => {
  for (const dir of [source, target]) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.delete(events).run();
  db.delete(scopingMessages).run();
  db.delete(cards).run();
  db.delete(repos).run();
  db.insert(repos)
    .values([
      { id: "source", name: "Source repo", path: source, defaultBranch: "main", createdAt: now() },
      { id: "target", name: "Target repo", path: target, defaultBranch: "main", createdAt: now() },
    ])
    .run();
});

function seedCard(id: string, overrides: Partial<typeof cards.$inferInsert> = {}) {
  db.insert(cards)
    .values({
      id,
      repoId: "source",
      title: `Card ${id}`,
      description: "## Problem\nBrute force.",
      status: "review",
      position: 3,
      baseBranch: "release/2",
      maxIterations: 9,
      timeoutMinutes: 45,
      reviewPlanBeforeImplementation: 1,
      grillMe: 1,
      scopingAuthorsPlan: 1,
      loopModel: "a-loop-model",
      createdAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .run();
  db.insert(scopingMessages)
    .values([
      { cardId: id, role: "user", content: "Where should the limit live?", createdAt: now() },
      { cardId: id, role: "assistant", content: "In loginRateLimit.ts.", createdAt: now() },
    ])
    .run();
}

const cardRows = () => db.select().from(cards).all();

describe("exportCards", () => {
  it("carries the intent and the scoping thread, and nothing that happened", () => {
    seedCard("card-1");

    const exported = exportCards({ cardId: "card-1" });

    expect(exported).toMatchObject({ version: 1, repoName: "Source repo" });
    expect(exported.cards).toHaveLength(1);
    expect(exported.cards[0]).toEqual({
      title: "Card card-1",
      description: "## Problem\nBrute force.",
      baseBranch: "release/2",
      source: "user",
      maxIterations: 9,
      timeoutMinutes: 45,
      reviewPlanBeforeImplementation: true,
      autoApprove: false,
      openPr: false,
      grillMe: true,
      scopingAuthorsPlan: true,
      plannerModel: null,
      loopModel: "a-loop-model",
      evaluatorModel: null,
      scoping: [
        { role: "user", content: "Where should the limit live?" },
        { role: "assistant", content: "In loginRateLimit.ts." },
      ],
    });
    // No status, no position, no ids, no history: none of it means anything
    // on another install.
    const keys = Object.keys(exported.cards[0]);
    expect(keys).not.toContain("status");
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("position");
  });

  it("exports a whole repository, oldest first, and names the file for it", () => {
    seedCard("card-1", { createdAt: "2026-01-01T00:00:00.000Z" });
    seedCard("card-2", { createdAt: "2026-02-01T00:00:00.000Z" });
    seedCard("other-repo-card", { repoId: "target" });

    const exported = exportCards({ repoId: "source" });

    expect(exported.cards.map((card) => card.title)).toEqual(["Card card-1", "Card card-2"]);
    expect(exportFileName(exported)).toMatch(/^radulf-source-repo-2-cards-\d{4}-\d{2}-\d{2}\.json$/);
    expect(exportFileName(exportCards({ cardId: "card-1" }))).toContain("-card-");
  });

  it("refuses a selector that names nothing", () => {
    expect(() => exportCards({})).toThrow(/cardId or repoId/);
    expect(() => exportCards({ repoId: "source" })).toThrow(/no cards to export/);
    expect(() => exportCards({ cardId: "nope" })).toThrow(/not found/);
  });
});

describe("importCards", () => {
  it("round-trips a card into another repository, in Backlog with a fresh id", async () => {
    seedCard("card-1");
    const exported = exportCards({ cardId: "card-1" });
    db.delete(cards).run();

    const result = await importCards("target", exported);

    expect(result.cardIds).toHaveLength(1);
    expect(result.cardIds[0]).not.toBe("card-1");
    const [imported] = cardRows();
    expect(imported).toMatchObject({
      repoId: "target",
      title: "Card card-1",
      description: "## Problem\nBrute force.",
      // Importing never starts work, whatever the card was doing before.
      status: "backlog",
      maxIterations: 9,
      reviewPlanBeforeImplementation: 1,
      grillMe: 1,
      scopingAuthorsPlan: 1,
      loopModel: "a-loop-model",
    });
    expect(db.select().from(scopingMessages).all().map((m) => m.content)).toEqual([
      "Where should the limit live?",
      "In loginRateLimit.ts.",
    ]);
    expect(db.select().from(events).all().map((e) => e.type)).toContain("cards.imported");
  });

  it("drops a base branch the target repository does not have, and says so", async () => {
    seedCard("card-1"); // baseBranch release/2, which only the source repo has
    const exported = exportCards({ cardId: "card-1" });

    const result = await importCards("target", exported);

    expect(result.notes).toEqual([
      'Target repo has no branch "release/2", so those cards use its default instead',
    ]);
    expect(cardRows().find((row) => row.repoId === "target")!.baseBranch).toBeNull();
  });

  it("keeps a base branch the target repository does have", async () => {
    seedCard("card-1");
    const exported = exportCards({ cardId: "card-1" });

    const result = await importCards("source", exported);

    expect(result.notes).toEqual([]);
    expect(cardRows().find((row) => row.id === result.cardIds[0])!.baseBranch).toBe("release/2");
  });

  it("refuses a repo it does not have", async () => {
    seedCard("card-1");
    await expect(importCards("nope", exportCards({ cardId: "card-1" }))).rejects.toThrow(/repo not found/);
  });
});

describe("parseCardExport", () => {
  const file = {
    version: 1,
    exportedAt: "2026-09-22T00:00:00.000Z",
    repoName: "Elsewhere",
    cards: [{ title: "A card" }],
  };

  it("fills in every field a file leaves out", () => {
    expect(parseCardExport(file).cards[0]).toMatchObject({
      title: "A card",
      description: "",
      baseBranch: null,
      source: "user",
      maxIterations: null,
      autoApprove: false,
      scoping: [],
    });
  });

  it("ignores a field it has never heard of, rather than refusing the file", () => {
    const fromTheFuture = { ...file, cards: [{ title: "A card", somethingNew: { deep: true } }] };
    expect(parseCardExport(fromTheFuture).cards[0].title).toBe("A card");
  });

  it("drops a scoping message whose speaker it cannot identify", () => {
    const parsed = parseCardExport({
      ...file,
      cards: [{
        title: "A card",
        scoping: [
          { role: "user", content: "keep" },
          { role: "evaluator", content: "drop: not a speaker in this thread" },
          { role: "assistant", content: "" },
          "not even an object",
        ],
      }],
    });

    expect(parsed.cards[0].scoping).toEqual([{ role: "user", content: "keep" }]);
  });

  it("refuses a version it does not read, an empty file, and a card with no title", () => {
    expect(() => parseCardExport({ ...file, version: 2 })).toThrow(/version 2/);
    expect(() => parseCardExport({ ...file, cards: [] })).toThrow(/no cards/);
    expect(() => parseCardExport({ ...file, cards: [{ description: "x" }] })).toThrow(/card 1 has no title/);
    expect(() => parseCardExport("not an object")).toThrow();
  });

  it("clamps a cap outside its range to unset rather than trusting it", () => {
    const parsed = parseCardExport({
      ...file,
      cards: [{ title: "A card", maxIterations: 10_000, timeoutMinutes: -5 }],
    });
    expect(parsed.cards[0]).toMatchObject({ maxIterations: null, timeoutMinutes: null });
  });
});
