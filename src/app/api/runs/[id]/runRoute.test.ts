import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestStateDir } from "@/testUtils/testDataDir";

const stateDir = setupTestStateDir("radulf-run-route-");

const { db, repos, cards, runs, now, TRANSCRIPTS_DIR } = await import("@/db");
const { GET } = await import("./route");

db.insert(repos)
  .values({
    id: "repo-1",
    name: "Repo",
    path: path.join(stateDir, "repo"),
    defaultBranch: "main",
    createdAt: now(),
  })
  .run();
db.insert(cards)
  .values({
    id: "card-1",
    repoId: "repo-1",
    title: "Card",
    description: "d",
    status: "planning",
    baseBranch: "main",
    position: 1,
    createdAt: now(),
    updatedAt: now(),
  })
  .run();
for (const [id, kind] of [
  ["run-critique", "critique"],
  ["run-loop", "loop"],
] as const) {
  db.insert(runs)
    .values({
      id,
      cardId: "card-1",
      kind,
      status: "completed",
      worktreePath: path.join(stateDir, "worktrees", id),
      branch: "ralph/x",
      startedAt: now(),
      endedAt: now(),
    })
    .run();
}

const transcriptDir = path.join(TRANSCRIPTS_DIR, "run-critique");
fs.mkdirSync(transcriptDir, { recursive: true });
fs.writeFileSync(
  path.join(transcriptDir, "critique.jsonl"),
  `${JSON.stringify({ t: "raw", line: "hello" })}\n${JSON.stringify({ t: "raw", line: "world" })}\n`,
);

function get(id: string) {
  return GET(new Request(`http://localhost/api/runs/${id}?iteration=0`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/runs/[id]?iteration=N transcript lookup", () => {
  it("serves critique.jsonl for critique runs regardless of the iteration value", async () => {
    const response = await get("run-critique");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.run.kind).toBe("critique");
    expect(body.lines.length).toBe(2);
  });

  it("still rejects a non-positive iteration for loop runs", async () => {
    const response = await get("run-loop");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/iteration must be a positive integer/);
  });
});
