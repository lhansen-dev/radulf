import { describe, expect, it } from "vitest";
import { filterTranscript, transcriptLineText, transcriptToText } from "./transcriptSearch";

const text = { t: "text", content: "Reading the sandbox profile" };
const reasoning = { t: "reasoning", content: "The seccomp filter blocks it" };
const tool = { t: "tool", name: "Read", input: { file_path: "src/server/sandbox/seatbelt.ts" } };
const ok = { t: "result", exit: "ok" };
const failed = { t: "result", exit: "failed", detail: "exit code 1" };
const usage = { t: "usage", inputTokens: 12, outputTokens: 34 };

describe("transcriptLineText", () => {
  it("renders each line kind the view renders", () => {
    expect(transcriptLineText(text)).toBe("Reading the sandbox profile");
    expect(transcriptLineText(reasoning)).toContain("The seccomp filter blocks it");
    expect(transcriptLineText(ok)).toBe("■ result: ok");
    expect(transcriptLineText(failed)).toBe("■ result: exit code 1");
    expect(transcriptLineText(usage)).toBe("▸ tokens: 12 in / 34 out");
  });

  it("includes a tool call's input, not just its preview", () => {
    expect(transcriptLineText(tool)).toContain("src/server/sandbox/seatbelt.ts");
  });

  it("says nothing for a line kind it does not render", () => {
    expect(transcriptLineText({ t: "something-new" })).toBe("");
  });

  it("names a redacted reasoning block rather than going blank", () => {
    expect(transcriptLineText({ t: "reasoning" })).toContain("redacted");
  });
});

describe("filterTranscript", () => {
  const lines = [text, reasoning, tool, ok, failed, usage];

  it("keeps everything when nothing has been typed", () => {
    expect(filterTranscript(lines, "")).toHaveLength(lines.length);
    expect(filterTranscript(lines, "   ")).toHaveLength(lines.length);
  });

  it("finds a path that only exists inside a tool call's input", () => {
    expect(filterTranscript(lines, "seatbelt.ts")).toEqual([tool]);
  });

  it("ignores case", () => {
    expect(filterTranscript(lines, "SECCOMP")).toEqual([reasoning]);
  });

  it("finds a failure by its detail", () => {
    expect(filterTranscript(lines, "exit code")).toEqual([failed]);
  });

  it("returns nothing when there is no match", () => {
    expect(filterTranscript(lines, "no-such-string")).toEqual([]);
  });
});

describe("transcriptToText", () => {
  it("joins the rendered lines and drops the ones that render nothing", () => {
    expect(transcriptToText([text, { t: "unknown" }, ok])).toBe(
      "Reading the sandbox profile\n■ result: ok",
    );
  });

  it("exports exactly what a filter left behind, so a hit survives the copy", () => {
    const filtered = filterTranscript([text, reasoning, tool], "seatbelt.ts");
    expect(transcriptToText(filtered)).toContain("seatbelt.ts");
    expect(transcriptToText(filtered)).not.toContain("Reading the sandbox profile");
  });
});
