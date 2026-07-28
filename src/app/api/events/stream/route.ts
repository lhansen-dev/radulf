import { bus, type RalphEvent } from "@/server/events";

export const dynamic = "force-dynamic";

/** SSE feed of every orchestrator event — the board's live-update channel. */
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
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      bus.on("event", send);
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
