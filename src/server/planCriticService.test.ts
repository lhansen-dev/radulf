import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const testDataDir = setupTestDataDir("radulf-planCriticService-");
// Imported after setupTestDataDir, like everything else that reaches @/db.
const { db, cards, repos, runs, now } = await import("@/db");
const {
  CRITIQUE_FILE,
  criticEnabled,
  namedSpecFiles,
  renderCriticPrompt,
  consecutiveCriticRevisions,
} = await import("./planCriticService");

describe("criticEnabled", () => {
  it("lets a per-card override beat the workspace mode either way", () => {
    expect(criticEnabled({ planCritic: 1, parentCardId: null }, { planCriticMode: "off" })).toBe(true);
    expect(criticEnabled({ planCritic: 0, parentCardId: "parent" }, { planCriticMode: "always" })).toBe(false);
  });

  it("falls back to the mode when the card has no override", () => {
    expect(criticEnabled({ planCritic: null, parentCardId: "parent" }, { planCriticMode: "breakdown" })).toBe(true);
    expect(criticEnabled({ planCritic: null, parentCardId: null }, { planCriticMode: "breakdown" })).toBe(false);
    expect(criticEnabled({ planCritic: null, parentCardId: null }, { planCriticMode: "always" })).toBe(true);
    expect(criticEnabled({ planCritic: null, parentCardId: "parent" }, { planCriticMode: "off" })).toBe(false);
  });
});

describe("namedSpecFiles", () => {
  it("returns each named spec once, in order of first appearance", () => {
    expect(
      namedSpecFiles("see specs/04-agent-pipeline.md and specs/17-task-scoping.md, specs/04-agent-pipeline.md again"),
    ).toEqual(["specs/04-agent-pipeline.md", "specs/17-task-scoping.md"]);
    expect(namedSpecFiles("nothing here", "")).toEqual([]);
  });
});

describe("renderCriticPrompt", () => {
  const template =
    "T={{TITLE}}\nD={{DESCRIPTION}}\n{{SCOPING_SECTION}}\nS={{SPEC_FILES}}\nV={{PLAN_VERSION}}\nP={{PLAN_MD}}\nC={{CRITERIA_MD}}\nR={{PROMPT_MD}}\n";

  it("fills every placeholder and always names the verdict file", () => {
    const rendered = renderCriticPrompt(template, {
      title: "Add critic",
      description: "Review plans",
      scoping: [
        { role: "user", content: "Keep it read-only." },
        { role: "planner", content: "1. Cap revisions?" },
      ],
      specFiles: ["specs/30-plan-critic.md", "specs/04-agent-pipeline.md"],
      planVersion: 3,
      planMd: "- [ ] task one",
      criteriaMd: "- it works",
      promptMd: "do the thing",
    });

    expect(rendered).toContain("T=Add critic");
    expect(rendered).toContain("D=Review plans");
    expect(rendered).toContain("SCOPING THREAD");
    expect(rendered).toContain("Operator: Keep it read-only.");
    expect(rendered).toContain("Planner (an earlier planning run): 1. Cap revisions?");
    expect(rendered).toContain("S=specs/30-plan-critic.md\nspecs/04-agent-pipeline.md");
    expect(rendered).toContain("V=3");
    expect(rendered).toContain("P=- [ ] task one");
    expect(rendered).toContain("C=- it works");
    expect(rendered).toContain("R=do the thing");
    expect(rendered).not.toContain("{{");
    expect(rendered).toContain(`.ralph/${CRITIQUE_FILE}`);
    expect(CRITIQUE_FILE).toBe("CRITIQUE.md");
  });

  it("uses fallbacks for an empty description, thread and spec list", () => {
    const rendered = renderCriticPrompt(template, {
      title: "Add critic",
      description: "",
      scoping: [],
      specFiles: [],
      planVersion: 1,
      planMd: "",
      criteriaMd: "",
      promptMd: "",
    });

    expect(rendered).toContain("D=(no description)");
    expect(rendered).not.toContain("SCOPING THREAD");
    expect(rendered).toContain("S=(the card names no spec files)");
    expect(rendered).toContain(".ralph/CRITIQUE.md");
  });

  it("does not repeat the verdict instruction when the template already has it", () => {
    const rendered = renderCriticPrompt("{{TITLE}}\nWrite to .ralph/CRITIQUE.md.", {
      title: "x",
      description: "",
      scoping: [],
      specFiles: [],
      planVersion: 1,
      planMd: "",
      criteriaMd: "",
      promptMd: "",
    });
    expect(rendered.match(/\.ralph\/CRITIQUE\.md/g)).toHaveLength(1);
  });
});

describe("consecutiveCriticRevisions", () => {
  function seedRun(id: string, cardId: string, kind: "loop" | "critique", startedAt: string, exitReason: string | null) {
    db.insert(runs)
      .values({
        id,
        cardId,
        kind,
        status: "completed",
        worktreePath: "/tmp/wt",
        branch: "ralph/x",
        exitReason,
        startedAt,
        endedAt: startedAt,
      })
      .run();
  }

  function seedCard(id: string) {
    db.insert(cards)
      .values({
        id,
        repoId: "repo-1",
        title: `Card ${id}`,
        description: "",
        status: "planning",
        baseBranch: "main",
        position: 1,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }

  it("counts critique revise runs since the latest loop run only", () => {
    db.insert(repos)
      .values({ id: "repo-1", name: "Repo", path: path.join(testDataDir, "repo"), defaultBranch: "main", createdAt: now() })
      .run();
    seedCard("card-a");
    seedCard("card-b");

    // card-a: an old revise before the loop, then two after; an approve in between.
    seedRun("r1", "card-a", "critique", "2024-01-01T00:00:00.000Z", "revise");
    seedRun("r2", "card-a", "loop", "2024-01-02T00:00:00.000Z", "done");
    seedRun("r3", "card-a", "critique", "2024-01-03T00:00:00.000Z", "revise");
    seedRun("r4", "card-a", "critique", "2024-01-04T00:00:00.000Z", "approve");
    seedRun("r5", "card-a", "critique", "2024-01-05T00:00:00.000Z", "revise");
    expect(consecutiveCriticRevisions("card-a")).toBe(2);

    // card-b: no loop run, so every revise counts; other cards' rows do not.
    seedRun("r6", "card-b", "critique", "2024-01-01T00:00:00.000Z", "revise");
    expect(consecutiveCriticRevisions("card-b")).toBe(1);
    expect(consecutiveCriticRevisions("card-none")).toBe(0);
  });
});
