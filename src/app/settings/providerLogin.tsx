"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../ui/api";
import { inputCls, secondaryButtonCls } from "./settingsUI";
import type { LoggableProvider, LoginView } from "@/server/providerLogin";
import { errorMessage } from "@/shared/errorMessage";

/**
 * How often to read a running login.
 *
 * A device-code flow only learns the operator authorized when pi's own poll
 * comes back, so this is the page's share of a wait measured in seconds. Fast
 * enough to feel live, slow enough not to be a busy loop on the one process
 * that also runs the orchestrator.
 */
const POLL_MS = 1_500;

/**
 * Connecting a provider from the app (spec 23).
 *
 * Renders pi's own login interaction: its events become the instructions on
 * screen, and its prompts become the one question outstanding. Radulf never
 * sees a token, so there is nothing here that stores one; answers go straight
 * back to pi, which writes its own auth.json.
 */
export function ProviderLoginSection({ onChanged }: { onChanged?: () => void }) {
  const [providers, setProviders] = useState<LoggableProvider[] | null>(null);
  const [login, setLogin] = useState<LoginView | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Subscriptions first, then everything else, behind a disclosure. */
  const [showAll, setShowAll] = useState(false);

  const refetch = useCallback(() => {
    api<LoggableProvider[]>("/api/provider-login")
      .then(setProviders)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(refetch, [refetch]);

  // One interval per running login, cleared the moment it settles. The ref
  // keeps the effect from restarting on every polled update.
  const loginId = login && (login.status === "waiting" || login.status === "prompting") ? login.id : null;
  // Assigned in an effect, not during render, and read only from the interval
  // below — the same shape useEventStream uses to keep a live callback out of
  // an effect's dependency list (src/app/ui/api.ts).
  const settled = useRef<() => void>(() => {});
  useEffect(() => {
    settled.current = () => {
      refetch();
      onChanged?.();
    };
  });
  useEffect(() => {
    if (!loginId) return;
    const tick = () => {
      api<LoginView>(`/api/provider-login/${loginId}`)
        .then((next) => {
          setLogin(next);
          if (next.status === "done") settled.current();
        })
        .catch(() => {});
    };
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [loginId]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const start = (providerId: string, type: "oauth" | "api_key") =>
    act(async () => {
      setAnswer("");
      setLogin(await api<LoginView>("/api/provider-login", { json: { providerId, type } }));
    });

  const submit = () =>
    act(async () => {
      if (!login?.prompt) return;
      const next = await api<LoginView>(`/api/provider-login/${login.id}`, {
        json: { token: login.prompt.token, value: answer },
      });
      setAnswer("");
      setLogin(next);
    });

  const cancel = () =>
    act(async () => {
      if (login) await api(`/api/provider-login/${login.id}`, { method: "DELETE" });
      setLogin(null);
      setAnswer("");
    });

  const logout = (provider: LoggableProvider) =>
    act(async () => {
      if (!confirm(`Disconnect ${provider.name}? Agents using it will stop working until you reconnect.`)) return;
      await api("/api/provider-login", { json: { providerId: provider.id, logout: true } });
      refetch();
      onChanged?.();
    });

  if (login) {
    return (
      <LoginFlow
        login={login}
        answer={answer}
        setAnswer={setAnswer}
        busy={busy}
        error={error}
        onSubmit={submit}
        onCancel={cancel}
        onDone={() => { setLogin(null); refetch(); }}
      />
    );
  }

  if (providers === null) return <p className="text-sm text-foreground/50">Loading providers…</p>;

  const subscriptions = providers.filter((p) => p.oauth?.subscription);
  const rest = providers.filter((p) => !p.oauth?.subscription);

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {subscriptions.map((p) => (
          <ProviderRow key={p.id} provider={p} busy={busy} onStart={start} onLogout={logout} />
        ))}
      </ul>

      {rest.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-sm text-foreground/60 hover:text-foreground"
          >
            {showAll ? "Hide" : `Show ${rest.length} more providers`}
          </button>
          {showAll && (
            <ul className="mt-2 flex flex-col gap-2">
              {rest.map((p) => (
                <ProviderRow key={p.id} provider={p} busy={busy} onStart={start} onLogout={logout} />
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="text-xs leading-relaxed text-foreground/45">
        Logins established here belong to Radulf, not to your personal pi or Claude directory.
        A terminal still works if you prefer one: <code className="text-foreground/70">make login</code> on
        a host, <code className="text-foreground/70">radulf-login</code> in the container.
      </p>

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </div>
  );
}

function ProviderRow({
  provider,
  busy,
  onStart,
  onLogout,
}: {
  provider: LoggableProvider;
  busy: boolean;
  onStart: (providerId: string, type: "oauth" | "api_key") => void;
  onLogout: (provider: LoggableProvider) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-foreground/10 p-3">
      <span className="text-sm font-medium">{provider.name}</span>
      {provider.connected ? (
        <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-xs text-green-200">
          connected{provider.connected.source ? ` · ${provider.connected.source}` : ""}
        </span>
      ) : (
        <span className="text-xs text-foreground/40">not connected</span>
      )}
      <span className="ml-auto flex gap-2">
        {provider.oauth && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onStart(provider.id, "oauth")}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-40"
          >
            {provider.oauth.label ?? (provider.oauth.subscription ? "Sign in" : "Connect")}
          </button>
        )}
        {provider.apiKey && (
          <button type="button" disabled={busy} onClick={() => onStart(provider.id, "api_key")} className={secondaryButtonCls}>
            Enter a key
          </button>
        )}
        {provider.connected && (
          <button type="button" disabled={busy} onClick={() => onLogout(provider)} className={`${secondaryButtonCls} text-red-300`}>
            Disconnect
          </button>
        )}
      </span>
    </li>
  );
}

/**
 * The running flow: pi's events as instructions, and its one outstanding
 * prompt as the question.
 *
 * A prompt can be withdrawn rather than answered — on a host install the
 * loopback callback can win the race against the paste box — so this renders
 * whatever `prompt` currently is, including nothing.
 */
function LoginFlow({
  login,
  answer,
  setAnswer,
  busy,
  error,
  onSubmit,
  onCancel,
  onDone,
}: {
  login: LoginView;
  answer: string;
  setAnswer: (value: string) => void;
  busy: boolean;
  error: string;
  onSubmit: () => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const prompt = login.prompt;
  // pi asks GitHub Copilot's host as a text prompt meant to be left blank for
  // github.com, so an empty answer has to be submittable. Every other kind
  // names something there is no blank form of.
  const answerable = prompt?.kind === "text" || answer.trim().length > 0;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-accent/30 bg-accent/[0.04] p-4">
      <p className="text-sm font-medium">Connecting {login.providerId}</p>

      <ol className="flex flex-col gap-2">
        {login.events.map((event, i) => (
          <li key={i} className="text-sm text-foreground/75">
            {event.type === "auth_url" && (
              <span className="flex flex-col gap-1">
                <a href={event.url} target="_blank" rel="noreferrer" className="text-accent underline">
                  Open this link to authorize
                </a>
                {event.instructions && <span className="text-xs text-foreground/55">{event.instructions}</span>}
              </span>
            )}
            {event.type === "device_code" && (
              <span className="flex flex-col gap-1">
                <span>
                  Enter code{" "}
                  <code className="rounded bg-foreground/10 px-1.5 py-0.5 text-base font-semibold tracking-widest">
                    {event.userCode}
                  </code>{" "}
                  at{" "}
                  <a href={event.verificationUri} target="_blank" rel="noreferrer" className="text-accent underline">
                    {event.verificationUri}
                  </a>
                </span>
                <span className="text-xs text-foreground/55">Waiting for you to authorize…</span>
              </span>
            )}
            {event.type === "info" && (
              <span className="flex flex-col gap-1">
                <span>{event.message}</span>
                {event.links?.map((link) => (
                  <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="text-xs text-accent underline">
                    {link.label ?? link.url}
                  </a>
                ))}
              </span>
            )}
            {event.type === "progress" && <span className="text-foreground/55">{event.message}</span>}
          </li>
        ))}
      </ol>

      {prompt && (
        <div className="flex flex-col gap-2">
          <label className="block text-sm text-foreground/75">
            {prompt.message}
            {prompt.kind === "select" ? (
              <select value={answer} onChange={(e) => setAnswer(e.target.value)} className={inputCls}>
                <option value="">Choose…</option>
                {prompt.options?.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                autoFocus
                type={prompt.kind === "secret" ? "password" : "text"}
                value={answer}
                placeholder={prompt.placeholder}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && answerable) { e.preventDefault(); onSubmit(); } }}
                className={inputCls}
              />
            )}
          </label>
          {prompt.kind === "manual_code" && (
            <p className="text-xs text-foreground/50">
              Paste either the authorization code or the whole URL your browser was redirected to, even
              if that page failed to load. It will have done, if your browser is not on this machine.
            </p>
          )}
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !answerable}
            className="self-start rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-on-accent disabled:opacity-40"
          >
            Continue
          </button>
        </div>
      )}

      {login.status === "done" && (
        <p role="status" className="text-sm text-green-300">
          Connected. Agents can use {login.providerId} now.
        </p>
      )}
      {(login.status === "failed" || login.status === "expired") && (
        <p role="alert" className="text-sm text-red-300">{login.error ?? "that login did not complete"}</p>
      )}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}

      <button
        type="button"
        onClick={login.status === "done" ? onDone : onCancel}
        disabled={busy}
        className={`${secondaryButtonCls} self-start`}
      >
        {login.status === "waiting" || login.status === "prompting" ? "Cancel" : "Back to providers"}
      </button>
    </div>
  );
}
