/**
 * Logging a provider in from the app (spec 23).
 *
 * pi exposes login as `ModelRuntime.login(providerId, type, interaction)`,
 * where the interaction is two callbacks: `notify` for what the operator
 * should see, and `prompt` for what they have to answer. The TUI is one
 * implementation of that interface; this module is another, driven over HTTP.
 *
 * The shape is a held promise. `login()` runs for the whole flow, and each
 * `prompt()` it makes parks on a promise this module resolves when the
 * browser posts an answer. So a session is a small state machine with at most
 * one question outstanding, read back by polling rather than pushed over the
 * event bus, which every open tab receives.
 *
 * Radulf never sees a token. pi writes the credential into its own
 * `auth.json` and owns refreshing it; all that crosses here is the operator's
 * answers.
 */
import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ClientError } from "./clientError";
import { emitEvent } from "./events";
import { getModelRuntime } from "./harness";
import { errorMessage } from "@/shared/errorMessage";

// pi-ai is only a transitive dependency, so its types are reached through the
// one pi-coding-agent API this module drives — the same approach the mock
// provider takes (src/server/harness/mock.ts).
type Interaction = Parameters<ModelRuntime["login"]>[2];
type AuthEvent = Parameters<Interaction["notify"]>[0];
type AuthPrompt = Parameters<Interaction["prompt"]>[0];
type AuthType = Parameters<ModelRuntime["login"]>[1];

/**
 * How long a session may sit unanswered before it is abandoned.
 *
 * An abandoned flow holds a pending promise and, for the providers that race
 * one, a bound callback port, so it cannot be left to the operator to close a
 * tab. Long enough to walk to another machine, read a code off the screen and
 * authorize there.
 */
const SESSION_TTL_MS = 10 * 60 * 1000;

/** What the browser polls for. Everything here is safe to render. */
export type LoginView = {
  id: string;
  providerId: string;
  status: "waiting" | "prompting" | "done" | "failed" | "expired";
  /** The events so far, oldest first, so a reconnecting poll misses nothing. */
  events: AuthEvent[];
  /** The question outstanding right now, or null. */
  prompt: PromptView | null;
  error: string | null;
};

/**
 * A prompt as the page needs it. Deliberately not the pi type: that carries
 * an `AbortSignal`, which does not serialize, and the page needs a token to
 * answer *this* question rather than whichever is current by the time its
 * request lands.
 */
export type PromptView = {
  token: string;
  kind: AuthPrompt["type"];
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
};

type Pending = {
  view: PromptView;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
};

type Session = {
  id: string;
  providerId: string;
  status: LoginView["status"];
  events: AuthEvent[];
  pending: Pending | null;
  error: string | null;
  abort: AbortController;
  expiresAt: number;
};

const sessions = new Map<string, Session>();

/** One login per provider, because the Anthropic flow binds a fixed callback
 * port and the second attempt would fail for an unrelated-looking reason. */
function activeFor(providerId: string): Session | undefined {
  for (const session of sessions.values()) {
    if (session.providerId === providerId && isLive(session)) return session;
  }
  return undefined;
}

function isLive(session: Session): boolean {
  return session.status === "waiting" || session.status === "prompting";
}

/** Expire what nobody came back for, and forget what has long finished. */
function sweep(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (now < session.expiresAt) continue;
    if (isLive(session)) {
      session.status = "expired";
      session.error = "this login was left unanswered and has been cancelled";
      session.abort.abort();
      rejectPending(session, new Error("login expired"));
      // Keep the expired view briefly so a returning poll is told why.
      session.expiresAt = now + 60_000;
      continue;
    }
    sessions.delete(id);
  }
}

function rejectPending(session: Session, reason: Error): void {
  const pending = session.pending;
  session.pending = null;
  pending?.reject(reason);
}

/** A provider the operator can actually log in to, and whether they have. */
export type LoggableProvider = {
  id: string;
  name: string;
  /** Present when the provider has a subscription or OAuth method. */
  oauth: { name: string; label: string | null; subscription: boolean } | null;
  /** Present when it takes an API key interactively. */
  apiKey: { name: string } | null;
  /** What is stored now, from pi's own check. */
  connected: { type: "api_key" | "oauth"; source: string | null } | null;
};

/**
 * Every provider with an interactive login, with its current status.
 *
 * Read from the runtime rather than hardcoded, so a pi upgrade that adds a
 * subscription needs no change here (spec 23).
 */
export async function listLoggableProviders(): Promise<LoggableProvider[]> {
  const runtime = await getModelRuntime();
  const out: LoggableProvider[] = [];
  for (const provider of runtime.getProviders()) {
    const auth = provider.auth;
    if (!auth?.oauth && !auth?.apiKey?.login) continue;
    // A provider whose check throws is reported as not connected rather than
    // failing the whole list: one misconfigured provider must not hide the
    // rest.
    let connected: LoggableProvider["connected"] = null;
    try {
      const check = await runtime.checkAuth(provider.id);
      if (check) connected = { type: check.type, source: check.source ?? null };
    } catch {
      connected = null;
    }
    out.push({
      id: provider.id,
      name: provider.name,
      oauth: auth.oauth
        ? {
            name: auth.oauth.name,
            label: auth.oauth.loginLabel ?? null,
            subscription: Boolean(auth.oauth.isSubscription),
          }
        : null,
      apiKey: auth.apiKey?.login ? { name: auth.apiKey.name } : null,
      connected,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Start a login and return its first view.
 *
 * `login()` is deliberately not awaited: it runs for the whole flow, and the
 * point of this module is to answer it in instalments. Its resolution and its
 * rejection both land on the session.
 */
export async function startLogin(providerId: string, type: AuthType): Promise<LoginView> {
  sweep();
  const runtime = await getModelRuntime();
  const provider = runtime.getProviders().find((p) => p.id === providerId);
  if (!provider) throw new ClientError("no such provider", 404);
  const method = type === "oauth" ? provider.auth?.oauth : provider.auth?.apiKey?.login;
  if (!method) throw new ClientError(`${provider.name} has no ${type} login`);
  if (activeFor(providerId)) {
    throw new ClientError(`a login to ${provider.name} is already in progress`, 409);
  }

  const session: Session = {
    id: randomUUID(),
    providerId,
    status: "waiting",
    events: [],
    pending: null,
    error: null,
    abort: new AbortController(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(session.id, session);

  void runtime
    .login(providerId, type, {
      signal: session.abort.signal,
      notify: (event) => {
        session.events.push(event);
        session.expiresAt = Date.now() + SESSION_TTL_MS;
      },
      prompt: (prompt) => ask(session, prompt),
    })
    .then(() => {
      session.status = "done";
      session.pending = null;
      session.expiresAt = Date.now() + 60_000;
      // The audit trail records that a provider was connected. Never the
      // answer, and never the auth_url, which carries the PKCE state.
      emitEvent("provider.login", { payload: { providerId, type } });
    })
    .catch((cause: unknown) => {
      if (session.status === "expired") return; // already explained
      session.status = "failed";
      session.pending = null;
      session.error = errorMessage(cause);
      session.expiresAt = Date.now() + 60_000;
    });

  return view(session);
}

/**
 * Park pi's question until the browser answers it.
 *
 * A prompt carries its own signal, aborted when something out of band settles
 * the step: on a host install the loopback callback can win the race against
 * the paste box, and then this question has to come back off the screen
 * rather than sit there answerable. Each prompt gets a fresh token so an
 * answer posted late cannot resolve whatever question replaced it.
 */
function ask(session: Session, prompt: AuthPrompt): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const pending: Pending = {
      view: {
        token: randomUUID(),
        kind: prompt.type,
        message: prompt.message,
        ...(("placeholder" in prompt && prompt.placeholder) ? { placeholder: prompt.placeholder } : {}),
        ...(prompt.type === "select" ? { options: prompt.options } : {}),
      },
      resolve,
      reject,
    };
    session.pending = pending;
    session.status = "prompting";
    session.expiresAt = Date.now() + SESSION_TTL_MS;

    const withdraw = () => {
      if (session.pending !== pending) return;
      session.pending = null;
      session.status = "waiting";
      reject(new Error("prompt withdrawn"));
    };
    prompt.signal?.addEventListener("abort", withdraw, { once: true });
  });
}

export function readLogin(id: string): LoginView {
  sweep();
  const session = sessions.get(id);
  if (!session) throw new ClientError("login not found", 404);
  return view(session);
}

/** Answer the outstanding prompt. The token names which question. */
export function answerLogin(id: string, token: string, value: string): LoginView {
  sweep();
  const session = sessions.get(id);
  if (!session) throw new ClientError("login not found", 404);
  const pending = session.pending;
  if (!pending) throw new ClientError("this login is not waiting on an answer", 409);
  if (pending.view.token !== token) {
    throw new ClientError("that answer is for a question this login has moved past", 409);
  }
  session.pending = null;
  session.status = "waiting";
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  pending.resolve(value);
  return view(session);
}

/** Abandon a login. Safe at any point: pi commits a credential or nothing. */
export function cancelLogin(id: string): void {
  const session = sessions.get(id);
  if (!session) throw new ClientError("login not found", 404);
  session.abort.abort();
  rejectPending(session, new Error("login cancelled"));
  sessions.delete(id);
}

/** Forget a provider's stored credential. */
export async function logoutProvider(providerId: string): Promise<void> {
  const runtime = await getModelRuntime();
  if (!runtime.getProviders().some((p) => p.id === providerId)) {
    throw new ClientError("no such provider", 404);
  }
  await runtime.logout(providerId);
  emitEvent("provider.logout", { payload: { providerId } });
}

/**
 * The session as the browser may see it.
 *
 * The events are sent whole rather than as a cursor: a login produces a
 * handful, and replaying them means a poll that missed one still renders the
 * right thing.
 */
function view(session: Session): LoginView {
  return {
    id: session.id,
    providerId: session.providerId,
    status: session.status,
    events: [...session.events],
    prompt: session.pending?.view ?? null,
    error: session.error,
  };
}

/** Test-only: drop every session so one test cannot leak into the next. */
export function resetLoginsForTests(): void {
  for (const session of sessions.values()) {
    session.abort.abort();
    rejectPending(session, new Error("reset"));
  }
  sessions.clear();
}
