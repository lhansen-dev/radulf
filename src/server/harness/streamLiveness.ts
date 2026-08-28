import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Byte-level proof-of-life for provider streams.
 *
 * The stall watchdog in `runHarness` resets on `AgentSessionEvent`s, which are
 * the *parsed* output of the provider stream. That misses keep-alive traffic
 * that never becomes an event. OpenRouter sends periodic `: OPENROUTER
 * PROCESSING` SSE comments during slow generations (high reasoning effort, big
 * open-ended tasks), and the `openai` SDK pi routes OpenRouter through drops
 * comment lines in its SSE decoder — `if (line.startsWith(':')) return null;`
 * — so they surface as nothing at all. A model that reasons for longer than
 * `stallTimeoutSeconds` without emitting a token therefore looked, to the
 * watchdog, exactly like a dead socket, and got killed as "stream hung".
 *
 * pi passes no `fetch` to the provider SDKs (`new OpenAI({ apiKey, baseURL,
 * defaultHeaders })`), and both the openai and Anthropic clients fall back to
 * `globalThis.fetch`. So the interception point is the global — no pi hook, no
 * patched dependency. Every SSE response body gets piped through a transform
 * that ticks the liveness callback on each chunk, so anything the provider
 * puts on the wire counts as alive, whether or not it parses into an event.
 *
 * Scoped per run via AsyncLocalStorage: the tick belongs to whichever
 * invocation's `session.prompt()` the request originated under, so one live
 * run cannot mask another's hang. Requests outside a run (model listings, web
 * search, the app's own fetches) find no store and pass through untouched.
 */

type Liveness = { tick: () => void };

const store = new AsyncLocalStorage<Liveness>();

let installed = false;

/**
 * Wrap `globalThis.fetch` once. Installed lazily on first use rather than at
 * module load, deliberately: Next.js patches the global fetch during boot, and
 * wrapping afterwards keeps this outermost instead of being bypassed.
 */
function installProbe(): void {
  if (installed) return;
  installed = true;

  const inner = globalThis.fetch;
  globalThis.fetch = async function livenessProbeFetch(input, init) {
    const res = await inner(input, init);
    const live = store.getStore();
    if (!live || !res.body) return res;
    // Only provider event streams. Everything else — JSON bodies, the model
    // catalog, Brave search — is left exactly as it came back.
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      return res;
    }
    const { tick } = live;
    const ticking = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        tick();
        controller.enqueue(chunk);
      },
    });
    return new Response(res.body.pipeThrough(ticking), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

/**
 * Run `fn` with `tick` armed as the liveness callback for any provider stream
 * it opens. Wrap the `session.prompt()` call — the async context propagates
 * through pi's agent loop down to the SDK's fetch.
 */
export function withStreamLiveness<T>(tick: () => void, fn: () => Promise<T>): Promise<T> {
  installProbe();
  return store.run({ tick }, fn);
}

/** Test seam: is a liveness context active on this async path? */
export function streamLivenessActive(): boolean {
  return store.getStore() !== undefined;
}
