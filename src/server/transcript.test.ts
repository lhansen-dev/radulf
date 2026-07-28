import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTranscriptChunk } from "./transcript";

describe("readTranscriptChunk", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-transcript-"));
    file = path.join(dir, "transcript.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("advances through bounded chunks without repeating events", async () => {
    const expected = Array.from({ length: 5 }, (_, index) => ({
      t: "text",
      role: "assistant",
      content: `event-${index}`,
    }));
    fs.writeFileSync(file, expected.map((event) => JSON.stringify(event)).join("\n") + "\n");

    let cursor = 0;
    const actual: unknown[] = [];
    do {
      const chunk = await readTranscriptChunk(file, cursor, false, 80);
      actual.push(...chunk.lines);
      expect(chunk.cursor).toBeGreaterThan(cursor);
      cursor = chunk.cursor;
      if (!chunk.hasMore) break;
    } while (true);

    expect(actual).toEqual(expected);
    expect(cursor).toBe(fs.statSync(file).size);
  });

  it("does not consume a live writer's partial trailing line", async () => {
    const first = JSON.stringify({ t: "text", role: "assistant", content: "first" });
    const second = JSON.stringify({ t: "text", role: "assistant", content: "second" });
    fs.writeFileSync(file, `${first}\n${second.slice(0, 20)}`);

    const initial = await readTranscriptChunk(file, 0, true);
    expect(initial.lines).toEqual([{ t: "text", role: "assistant", content: "first" }]);
    const waiting = await readTranscriptChunk(file, initial.cursor, true);
    expect(waiting.lines).toEqual([]);
    expect(waiting.cursor).toBe(initial.cursor);

    fs.appendFileSync(file, `${second.slice(20)}\n`);
    const completed = await readTranscriptChunk(file, initial.cursor, true);
    expect(completed.lines).toEqual([{ t: "text", role: "assistant", content: "second" }]);
    expect(completed.cursor).toBe(fs.statSync(file).size);
  });

  it("tails a bounded window when no cursor is supplied", async () => {
    const events = Array.from({ length: 20 }, (_, index) => ({
      t: "raw",
      line: `line-${String(index).padStart(2, "0")}`,
    }));
    fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");

    const chunk = await readTranscriptChunk(file, null, false, 150);

    expect(chunk.truncated).toBe(true);
    expect(chunk.lines.length).toBeGreaterThan(0);
    expect(chunk.lines.at(-1)).toEqual(events.at(-1));
    expect(chunk.cursor).toBe(fs.statSync(file).size);
  });

  it("returns an empty chunk for a transcript that does not exist yet", async () => {
    await expect(readTranscriptChunk(file, 0, true)).resolves.toEqual({
      lines: [],
      cursor: 0,
      hasMore: false,
      truncated: false,
      reset: false,
    });
  });
});
