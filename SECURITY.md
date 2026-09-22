# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, not through public GitHub issues.

Use GitHub's [private vulnerability reporting](https://github.com/lhansen-dev/radulf/security/advisories/new)
(Security → Advisories → Report a vulnerability) so the report stays confidential
until a fix is available. Include reproduction steps and the affected version or
commit. You can expect an initial response within a few days.

If you cannot use GitHub's reporting flow, email <contact@lhansen.dev> instead.

## Trust model — read this before deploying

Radulf is designed as a **single-user, local-first** tool. Its threat model
assumes the operator trusts the machine it runs on. Two properties matter:

- **Loop agents execute arbitrary code, bounded by the run sandbox.** Cards
  run a coding agent against a local git repository inside an isolated
  worktree, and that agent runs with `--dangerously-skip-permissions` — no
  interactive approval, no deny-list the model argues with (decision 7).
  As of [`specs/14-sandboxing.md`](specs/14-sandboxing.md), that permission
  posture is enforced by the kernel, not just by prompt text and the
  worktree cwd: an OS sandbox (Seatbelt on macOS, bubblewrap + seccomp on
  Linux) restricts agent bash's filesystem access, network egress, and Unix
  sockets, and in-process path guards constrain the file tools to the same
  boundary. This narrows the blast radius; it does not eliminate the trust
  requirement. **Operator still trusts the machine:** the sandbox is not a
  security boundary against a hostile *operator*, a compromised host, or a
  malicious model provider — see spec 14's threat model for the full list of
  trusted/untrusted parties, and [`SANDBOXING.md`](docs/SANDBOXING.md) for how the
  containment is implemented. Only register repositories and run tasks you
  would run yourself. **Accepted residual:** everything the agent reads
  reaches the model provider by construction (tool output enters the
  context window), and a *merged* diff — once a human approves it in In
  Review — is trusted like any other commit; the sandbox bounds what a run
  can do, not what an approved diff can do. **One optional, opt-in residual
  (default off):** `sandboxWeakerIsolationForGoTls` allows the macOS `trustd`
  service so Go-family toolchains (go, gh, gcloud, terraform, kubectl) can
  verify TLS — without it their HTTPS fetches fail under the sandbox. `trustd`
  runs outside the sandbox and its certificate-revocation lookups bypass the
  egress allowlist, a low-bandwidth exfil channel; enable it only for repos
  whose toolchain needs it.
- **Auth is optional and gates the whole app.** With no auth configured the
  `make dev` / `make start` targets bind `127.0.0.1` and Radulf is meant for
  localhost only. To expose it beyond localhost you **must** set
  `RADULF_AUTH_PASSWORD_HASH` (a bcrypt hash); this puts every page, API route,
  and SSE stream behind a single-password login, and flips the bind to
  `0.0.0.0`. The one exception is `GET /api/health`, the liveness check a
  container `HEALTHCHECK` or reverse proxy probes without a session; it reveals
  only that the process is up and whether a restart is pending. The bind address is derived from that one variable so the insecure
  combination — listening on the LAN with the login gate off — is not reachable
  by accident. Note that Next's own default is `0.0.0.0`: if you invoke
  `next dev`/`next start` directly instead of through the Makefile, pass
  `-H 127.0.0.1` yourself. See
  [README → Authentication](README.md#authentication-optional) and
  [`specs/08-hosting-auth.md`](specs/08-hosting-auth.md) for the full model,
  including CSRF/origin checks (`RADULF_ALLOWED_ORIGIN`) and session rotation.

The cross-origin (CSRF) check on mutating requests applies **whether or not
auth is enabled**. Radulf drives coding agents with
`--dangerously-skip-permissions`, so a page the operator merely visits must not
be able to blind-POST to their localhost instance — a cross-origin JSON `fetch`
is stopped by preflight, but a `text/plain` body is a CORS *simple* request that
would otherwise reach the handler unpreflighted. The check is same-origin in
the strict sense: the `Origin` must name the exact host and port the request was
addressed to, or `RADULF_ALLOWED_ORIGIN`. A page on another `localhost` port is
rejected, because browsers treat every localhost port as one site and would
attach the session cookie to its requests. Requests carrying no `Origin`
header at all (curl, scripts, the app itself) are unaffected.

Provider API keys (OpenRouter, oMLX, Brave) are write-only over HTTP:
`GET /api/settings` renders any key that is set as `••••••••`, and sending that
marker back leaves the stored value untouched. At rest they are encrypted with
AES-256-GCM under a key derived from `data/auth-secret`
(`src/server/settingsCrypto.ts`). That secret sits beside the database it
protects, so this is not protection against anyone who can read `data/` — that
directory is as sensitive as the keys in it, and the sandbox denies agent
access to it wholesale. What it does cover is a copy of the database alone: a
`make db-backup` snapshot, a stray `radulf.db` in a bug report, a restore from
a volume backup taken without the secret. Rows written before that encryption
existed stay readable and are re-encrypted on their next write.

Session cookies are HMAC-signed with the secret in `data/auth-secret`. There is
no server-side session store, so the kill switch for a leaked cookie is rotating
that secret: delete `data/auth-secret` and restart — every outstanding session
becomes invalid at once. **That also makes every stored provider key
undecryptable**, because both uses derive from the same file. Radulf then logs
`could not be decrypted` for each affected key and reads it as unset; re-enter
the keys in Settings afterwards.

`data/auth-secret` and `data/radulf.db` are written `0600`, and an install that
predates that is tightened in place at boot. Both files were previously created
at whatever the umask allowed, which on a stock host is `0644`: the
session-signing key and every provider key and transcript, readable by every
other account on the machine.

## Supported versions

Radulf is pre-1.0 and under active development. Only the latest `main` is
supported; fixes land there.
