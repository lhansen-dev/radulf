import { bus, type RalphEvent, type TranscriptPush } from "@/server/events";

/** SSE feed of every orchestrator event, plus live transcript pushes — the
 * board's (and the transcript view's) live-update channel. */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: RalphEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
      };
      // Same `data:` framing as `send`, distinguished by `kind` so the client
      // can tell a transcript push apart from a durable `RalphEvent` — these
      // never go through `emitEvent`/the `events` table (see TranscriptPush's
      // doc comment), only this bus channel.
      const sendTranscript = (push: TranscriptPush) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: "transcript", ...push })}\n\n`));
        } catch {
          cleanup();
        }
      };
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 25_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        bus.off("event", send);
        bus.off("transcript", sendTranscript);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      bus.on("event", send);
      bus.on("transcript", sendTranscript);
      req.signal.addEventListener("abort", cleanup, { once: true });
      controller.enqueue(encoder.encode(`: connected\n\n`));
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
