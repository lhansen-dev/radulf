# 23: Logging a provider in from the app

Decided 2026-09-22. Amends the posture stated in `GithubSection`
(`src/app/settings/page.tsx`) and echoed in
[HOW_IT_WORKS.md](../docs/HOW_IT_WORKS.md) that interactive OAuth belongs in
the operator's terminal. Narrows it rather than reversing it, and restates the
reason.

Locked decision 1 and decision 6 are untouched. Nothing here changes what an
agent may do or what merges; it changes only where a credential is
established.

## The problem

Subscription logins are established by running `pi` and typing `/login` inside
it: `make login` on a host, `radulf-login` in the container. The credential
lands in `<data dir>/pi-agent/auth.json`, which is Radulf's own agent dir
rather than the operator's `~/.pi`, so a `pi` login from a personal shell does
not count.

That is fine on a laptop, where the terminal is the same terminal that ran
`make dev`. It is wrong on a server or in a container, for the same reason
[spec 21](21-clone-on-register.md) found repository registration wrong there:
the assumption that the operator is sitting at the machine running Radulf. In
the container the login is `docker compose exec -it radulf radulf-login`,
followed by driving a full-screen TUI over `docker exec` to type one command,
and quitting it with Ctrl+C. Settings currently just prints
`make login` and hopes.

The practical consequence is worse than the friction. The easy way out is to
paste a long-lived API key into Settings instead, which is a strictly worse
credential than a refreshing subscription token, and Radulf's own Settings
page makes that the path of least resistance.

## What makes this feasible now

pi does not only expose `/login` as a TUI command. `ModelRuntime`, which
Radulf already constructs as a process-wide singleton against its own
`auth.json` (`getModelRuntime` in `src/server/harness/pi.ts`), exposes:

```ts
login(providerId, type: "api_key" | "oauth", interaction: AuthInteraction): Promise<Credential>
logout(providerId): Promise<void>
checkAuth(providerId): Promise<AuthCheck | undefined>
```

`AuthInteraction` is two callbacks the caller supplies, and both are already
shaped for a user interface rather than for a terminal:

- `notify(event)` where the event is `auth_url` with a link, `device_code`
  with a user code and a verification URI, `info` with links, or `progress`
  with a message.
- `prompt(p): Promise<string>` where the prompt is `text`, `secret`,
  `select` with labelled options, or `manual_code`.

So the terminal was never the contract. The TUI is one implementation of
`AuthInteraction`, and a web page is another.

## The decision

**Radulf drives `ModelRuntime.login` from a route, and Settings renders the
interaction.** A login session is created, the browser reads the current
event, answers the current prompt, and the session ends when pi resolves a
credential or rejects.

- **Only pi providers.** `gh` stays in the terminal. Radulf shells out to
  `gh` as a foreign binary, and `gh auth login --device` has no typed
  interface, only stdout that can change on any release. So the line moves
  from "interactive OAuth belongs in the terminal" to **drive a login where
  a typed interface exists, shell out where one does not**, which is the
  distinction that actually predicts which one breaks.
- **A session-scoped poll, not the SSE bus.** The bus in
  `src/server/events.ts` broadcasts to every open tab, and an `auth_url`
  carries the PKCE `state`. A login is read back only by the request that
  started it.
- **One login in flight per provider.** The Anthropic flow binds a fixed
  callback port (53692) and rejects if it is taken, so two concurrent logins
  to the same provider would fail the second one for an unrelated-looking
  reason. One at a time is also what an operator means.
- **Sessions are in-memory and die with the process.** A credential is
  either committed to `auth.json` by pi or it is not; a half-finished OAuth
  exchange is not resumable state, and persisting a PKCE verifier to buy
  restart-survival for a thirty second flow would be storing a secret to
  solve a problem nobody has. A session also expires on its own, so an
  abandoned one cannot hold a callback port or a pending promise forever.
- **Prompt answers are never recorded.** A `secret` or `manual_code` answer
  is a credential in flight. It is not logged, not stored, and never reaches
  the `events` table. The audit event records that a provider was logged in
  or out and nothing else: no answer, and no `auth_url`, because that URL
  carries the `state` the flow's integrity depends on.
- **Logout and status too.** `checkAuth` is already used server-side to turn
  "0 models" into a real message, but Settings cannot show whether a provider
  is connected at all today. The same surface reports it, and offers
  `logout`.

## The callback server, and why headless is the easy case

The Anthropic and Codex flows start a loopback callback server and race it
against a `manual_code` prompt, cancelling whichever loses. pi's own
documentation names the remote case: the browser cannot reach the loopback
callback, so paste the final redirect URL or the authorization code instead.

That makes the container the straightforward case. The callback server binds
the container's loopback, the operator's browser never reaches it, and the
paste box is the path. No port needs publishing, and the authorizing happens
in the operator's own browser as it should. Copilot does not even need the
paste: its flow is a device code, so the page shows a code and a URI and pi
polls.

On a host install the callback can win, which is better when it happens. The
consequence for this design is that **a prompt may be withdrawn**: the prompt
carries its own `AbortSignal` for exactly this case, so the page has to be
able to take a question back off the screen, not merely add and answer
questions.

## Data model

None. No table, no migration. Login sessions live in a module-level map, the
same way the scoping turn guard (`turnsInFlight`) and the sandbox policy claim
do, and credentials continue to live where pi puts them, in
`<data dir>/pi-agent/auth.json`.

## Accepted residuals

- **Anyone past the password gate can start a login, read auth status, or log
  a provider out.** That is the same trust `POST /api/repos`,
  `POST /api/repos/clone` and every agent run already extend, and the
  password gate in [AUTHENTICATION.md](../docs/AUTHENTICATION.md) is what
  stands between the internet and all of them. Logging a provider out is the
  most destructive thing this adds, and it destroys no work.
- **A pasted code crosses the browser and the server.** So does every
  provider API key Settings already accepts. It is a reason to run the
  deployment behind TLS, which SECURITY.md already is, not a reason to keep
  the flow in a TUI.
- **No login without a browser.** The flow needs the operator to open a URL.
  `radulf-login` and `make login` stay, and stay documented, for anyone who
  wants them or who is automating a first boot.

## What this does not do

- **No credential storage of Radulf's own.** pi owns `auth.json`, including
  refresh. Radulf never reads a token, never copies one, and never writes
  one; it hands pi the operator's answers.
- **No `gh` login.** See above.
- **No provider catalogue changes.** Which providers can be logged in is
  whatever `ModelRuntime.getProviders()` reports has an interactive method,
  read at request time rather than hardcoded, so a pi upgrade that adds a
  subscription needs no change here.
