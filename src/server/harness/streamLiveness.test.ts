import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runHarness, type HarnessSession } from "./index";
import { streamLivenessActive, withStreamLiveness } from "./streamLiveness";

/**
 * The probe wraps whatever `globalThis.fetch` is when it first installs, so the
 * fake has to be in place before the first `withStreamLiveness` call in this
 * file. `respond` stays swappable per test because the installed wrapper closes
 * over this stable arrow, not over the handler. That's also why the stub is
 * installed once via `beforeAll`/`afterAll` rather than per-test `vi.stubGlobal`
 * + `afterEach` (the repo's usual pattern elsewhere): re-stubbing between tests
 * would restore the real `fetch` after the first test, and `streamLiveness`'s
 * own install-once guard would then never re-wrap it, silently sending later
 * tests' fetches to the real `fetch`.
 */
let respond: (input: unknown, init?: unknown) => Promise<Response>;
beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    ((input: unknown, init?: unknown) => respond(input, init)) as unknown as typeof fetch,
  );
});

// Undo the stub once every test in this file has run, so a real `fetch` is
// back in place for any other test file sharing this worker.
afterAll(() => {
  vi.unstubAllGlobals();
});

/** An SSE body that emits `chunks` in order, `gapMs` apart. */
function sseResponse(chunks: string[], gapMs: number, contentType = "text/event-stream") {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        await new Promise((r) => setTimeout(r, gapMs));
        controller.enqueue(new TextEncoder().encode(c));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("stream liveness probe", () => {
  it("ticks on SSE comment pings that never parse into an event", async () => {
    // Exactly the OpenRouter keep-alive the openai SDK's decoder swallows.
    respond = async () =>
      sseResponse([": OPENROUTER PROCESSING\n\n", ": OPENROUTER PROCESSING\n\n"], 10);

    let ticks = 0;
    await withStreamLiveness(
      () => ticks++,
      async () => {
        await drain(await fetch("mock://openrouter/api/v1/chat/completions"));
      },
    );

    expect(ticks).toBeGreaterThanOrEqual(2);
  });

  it("passes the stream through byte-for-byte", async () => {
    const parts = ['data: {"a":1}\n\n', ": ping\n\n", 'data: {"b":2}\n\n'];
    respond = async () => sseResponse(parts, 1);

    const text = await withStreamLiveness(
      () => {},
      async () => drain(await fetch("mock://example/v1")),
    );

    expect(text).toBe(parts.join(""));
  });

  it("leaves non-SSE responses untouched", async () => {
    respond = async () => sseResponse(['{"models":[]}'], 1, "application/json");

    let ticks = 0;
    const text = await withStreamLiveness(
      () => ticks++,
      async () => drain(await fetch("mock://example/models")),
    );

    expect(text).toBe('{"models":[]}');
    expect(ticks).toBe(0);
  });

  it("does not tick outside a run — no store, no interception", async () => {
    respond = async () => sseResponse([": ping\n\n"], 1);

    expect(streamLivenessActive()).toBe(false);
    // A bare fetch (model listing, the app's own requests) must still work.
    expect(await drain(await fetch("mock://example/v1"))).toBe(": ping\n\n");
  });

  it("scopes the tick to the run that opened the stream", async () => {
    respond = async () => sseResponse([": ping\n\n", ": ping\n\n"], 10);

    let a = 0;
    let b = 0;
    await Promise.all([
      withStreamLiveness(
        () => a++,
        async () => {
          await drain(await fetch("mock://example/a"));
        },
      ),
      withStreamLiveness(
        () => b++,
        // This run opens no stream: it must not inherit the other's liveness.
        async () => {
          await new Promise((r) => setTimeout(r, 60));
        },
      ),
    ]);

    expect(a).toBeGreaterThanOrEqual(2);
    expect(b).toBe(0);
  });
});

describe("runHarness with a ping-only provider stream", () => {
  const scratch = "/tmp/ralph-liveness-test";

  /** A session whose prompt consumes a provider stream but emits no events —
   * the shape of run yxQl1Swi0dUzN_11uAgxf: tool results returned, then a long
   * silent generation kept alive only by OpenRouter's comment pings. */
  function pingOnlySession(): () => Promise<HarnessSession> {
    return async () => ({
      subscribe: () => () => {},
      async prompt() {
        await drain(await fetch("mock://openrouter/api/v1/chat/completions"));
      },
      async abort() {},
      dispose() {},
    });
  }

  it("does not stall while only keep-alive comments arrive", async () => {
    // Eight pings 20ms apart: every gap is under the 100ms watchdog, but not
    // one of them produces an AgentSessionEvent. Before the probe, the run was
    // killed at 100ms as "stream hung".
    respond = async () => sseResponse(Array(8).fill(": OPENROUTER PROCESSING\n\n"), 20);
    fs.mkdirSync(scratch, { recursive: true });

    const result = await runHarness({
      provider: "openrouter",
      prompt: "",
      model: "m",
      reasoningLevel: "max",
      cwd: scratch,
      transcriptPath: path.join(scratch, "pings.jsonl"),
      timeoutMs: 60_000,
      stallTimeoutMs: 100,
      createSession: pingOnlySession(),
    });

    expect(result.stalled).toBe(false);
    expect(result.error).toBe("");
  }, 15_000);

  it("still stalls when the stream goes truly silent", async () => {
    // Two pings, then nothing for longer than the watchdog: a dead socket is
    // still caught. The probe must not defeat the watchdog, only inform it.
    respond = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 2; i++) {
              await new Promise((r) => setTimeout(r, 20));
              controller.enqueue(new TextEncoder().encode(": OPENROUTER PROCESSING\n\n"));
            }
            await new Promise((r) => setTimeout(r, 30_000)); // never resolves in time
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    fs.mkdirSync(scratch, { recursive: true });

    const result = await runHarness({
      provider: "openrouter",
      prompt: "",
      model: "m",
      reasoningLevel: "max",
      cwd: scratch,
      transcriptPath: path.join(scratch, "dead.jsonl"),
      timeoutMs: 60_000,
      stallTimeoutMs: 100,
      createSession: pingOnlySession(),
    });

    expect(result.stalled).toBe(true);
    expect(result.error).toContain("no output");
  }, 15_000);
});
