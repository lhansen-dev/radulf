import { describe, expect, it } from "vitest";
import { parseProposals, readPmPrompt } from "./pm";

describe("readPmPrompt", () => {
  it("renders a configured template with the current open cards", () => {
    expect(
      readPmPrompt(
        ["First card", "Second card"],
        "Open work:\n{{EXISTING_CARDS}}",
      ),
    ).toBe("Open work:\n- First card\n- Second card");
  });

  it("renders an explicit empty-state entry", () => {
    expect(readPmPrompt([], "{{EXISTING_CARDS}}")).toBe("- (none)");
  });
});

describe("parseProposals", () => {
  const one = (title: string) =>
    `[{"title": ${JSON.stringify(title)}, "description": "d", "rationale": "r"}]`;

  it("parses a bare JSON array", () => {
    expect(parseProposals(one("A"))).toEqual([
      { title: "A", description: "d", rationale: "r" },
    ]);
  });

  it("parses a fenced array", () => {
    expect(parseProposals("```json\n" + one("A") + "\n```")).toHaveLength(1);
  });

  // Regression: an observed live Improvement Run lost this exact shape — a
  // sentence of preamble before the fenced array — and the run went on to end
  // "proposer ran dry" having created zero cards.
  it("parses an array preceded by prose the model was told not to emit", () => {
    const text =
      "Based on my review, I found a clear gap: `pm.ts` exports a helper that " +
      "has no direct tests.\n\n```json\n" +
      one("Add a parseProposals unit test suite") +
      "\n```";
    expect(parseProposals(text)).toEqual([
      {
        title: "Add a parseProposals unit test suite",
        description: "d",
        rationale: "r",
      },
    ]);
  });

  it("parses an array with prose on both sides and no fence", () => {
    expect(parseProposals(`Here you go: ${one("A")} — hope that helps.`)).toHaveLength(1);
  });

  // Regression: the same live pass wrote ```json *inside* a description
  // string, which closes a lazy fence match early. The outermost bracket span
  // is the fallback that survives it.
  it("recovers when a description contains a code fence of its own", () => {
    const text =
      "Here is my proposal.\n\n```json\n" +
      `[{"title":"A","description":"strips leading/trailing \\u0060\\u0060\\u0060json fences before parsing","rationale":"r"}]` +
      "\n```";
    expect(parseProposals(text)).toEqual([
      {
        title: "A",
        description: "strips leading/trailing ```json fences before parsing",
        rationale: "r",
      },
    ]);
  });

  it("prefers a fenced array over bracket text elsewhere in the prose", () => {
    const text = `I considered [a, b, c] first.\n\n\`\`\`json\n${one("Chosen")}\n\`\`\``;
    expect(parseProposals(text)[0]?.title).toBe("Chosen");
  });

  it("coerces a missing rationale and drops empty-field items", () => {
    const text = `[{"title":"A","description":"d"},{"title":"","description":"d"},{"title":"B"}]`;
    expect(parseProposals(text)).toEqual([{ title: "A", description: "d", rationale: "" }]);
  });

  it("caps the result at 3", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      title: `t${i}`,
      description: "d",
      rationale: "r",
    }));
    expect(parseProposals(JSON.stringify(items))).toHaveLength(3);
  });

  it("returns [] for prose with no array, non-array JSON, and malformed input", () => {
    expect(parseProposals("I have nothing to propose.")).toEqual([]);
    expect(parseProposals(`{"title":"A","description":"d"}`)).toEqual([]);
    expect(parseProposals("```json\n[{title: broken]\n```")).toEqual([]);
    expect(parseProposals("")).toEqual([]);
  });
});
