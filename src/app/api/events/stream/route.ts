import { bus, type RalphEvent, type TranscriptPush } from "@/server/events";

/**
 * How many bytes the stream may hold for a client that is not reading before
 * it is dropped.
 *
 * `controller.enqueue` neither blocks nor rejects on a slow consumer — it
 * queues. A browser tab that stopped reading (suspended, asleep, behind a
 * stalled connection) therefore accumulates every orchestrator event and
 * every transcript push in this process's memory, and a chatty iteration
 * pushes hundreds of frames a second. Nothing bounded that.
 *
 * A ByteLengthQueuingStrategy makes `desiredSize` the room actually left, so
 * the bound is in bytes rather than in frames of unknown size. Reaching it
 * closes the stream: EventSource reconnects by itself, and the client
 * refetches on reconnect (`useWorkData`) because this stream never replayed
 * missed events anyway. Dropping one reader is strictly better than growing
 * until the process that runs the orchestrator dies.
 */
const STREAM_BUFFER_BYTES = 1024 * 1024;

/** SSE feed of every orchestrator event, plus live transcript pushes — the
 * board's (and the transcript view's) live-update channel. */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream(
    {
      start(controller) {
        const write = (frame: string) => {
          // desiredSize is null once the stream is closed or errored.
          const room = controller.desiredSize;
          if (room === null || room <= 0) {
            cleanup();
            return;
          }
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            cleanup();
          }
        };
        const send = (event: RalphEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
        // Same `data:` framing as `send`, distinguished by `kind` so the client
        // can tell a transcript push apart from a durable `RalphEvent` — these
        // never go through `emitEvent`/the `events` table (see TranscriptPush's
        // doc comment), only this bus channel.
        const sendTranscript = (push: TranscriptPush) =>
          write(`data: ${JSON.stringify({ kind: "transcript", ...push })}\n\n`);
        const heartbeat = setInterval(() => write(`: ping\n\n`), 25_000);
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
        write(`: connected\n\n`);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: STREAM_BUFFER_BYTES }),
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
