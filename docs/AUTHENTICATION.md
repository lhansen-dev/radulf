# Authentication

By default Radulf runs on `localhost` with no authentication, which is the right
posture for a single-user local tool. If you expose it beyond your own machine,
turn authentication on — it gates every page and every API route, including the
LAN listener, behind a single password.

The two are wired together, so the insecure combination cannot be reached by
accident: the `make dev` and `make start` targets bind `127.0.0.1` while
`RADULF_AUTH_PASSWORD_HASH` is unset, and `0.0.0.0` once it is set. Next's own
default is `0.0.0.0` for both, so if you run `next dev`/`next start` yourself,
pass `-H 127.0.0.1` unless auth is on.

## Turning it on

Generate a bcrypt hash of your chosen password:

```bash
node -e 'console.log(require("bcryptjs").hashSync(process.argv[1], 12))' -- '<password>'
```

Set the result as `RADULF_AUTH_PASSWORD_HASH`. When that variable is unset, auth
is disabled and Radulf runs in its default no-auth mode.

If you are serving Radulf on a public hostname, also set `RADULF_ALLOWED_ORIGIN`
to the full origin, including the scheme and any non-default port. For example,
use `RADULF_ALLOWED_ORIGIN=https://radulf.example.com`.
Mutating requests are accepted only from the configured origin. Loopback use
also accepts the exact local host and port addressed by the browser. A page on
another `localhost` port is not the same origin, even though browsers send it
the same cookies.

## How it behaves

Visiting any page without a valid cookie redirects you to `/login`. A successful
login sets a signed session cookie valid for **30 days**. **Sign out everywhere**
(Settings → General → Session, or `POST /api/auth/logout`) signs you out on every
device and returns you to the login page — see [Revoking a session](#revoking-a-session).

The login endpoint throttles guessing, in one of two ways depending on whether
it can tell clients apart:

- **With `RADULF_TRUSTED_PROXY_IP_HEADER` set**, each client address gets its own
  budget: **5 failed attempts per minute**, then `429 Too Many Requests`.
- **Without it** there is no trustworthy client identity, so every direct
  request shares one budget. A hard cutoff there would let anyone who can reach
  the port lock *you* out with five bad guesses, so the shared budget escalates
  **delay** instead — each recent failure adds 2s, capped at 15s. Guessing
  becomes impractical; the correct password is never refused.

Set `RADULF_TRUSTED_PROXY_IP_HEADER` to the header your reverse proxy populates
with the real client IP (e.g. `x-forwarded-for`) when you deploy behind one.
Leave it unset otherwise — trusting a client-settable header would let an
attacker forge a fresh identity per attempt and evade the limit entirely.

## Revoking a session

Cookies are HMAC-SHA256 signed against a secret generated on first boot and
stored in `data/auth-secret` (gitignored). There is no server-side session
store, so one cookie cannot be revoked on its own — but all of them can.

**Logging out is the kill switch for a leaked cookie.** It writes the time to
`data/sessions-not-before`, and every session issued up to then stops working
in every browser and every process on that data directory, including copies
of the cookie you never knew existed. Sign in again afterwards.

Rotating the secret (delete `data/auth-secret` and restart) also invalidates
every cookie, but it makes every stored provider key undecryptable too, so
prefer logging out.

## Under the hood

```
   Browser              Next.js proxy                Route handlers
      │                         │                          │
      │── GET /any-page ───────▶│                          │
      │◀─ 307 → /login ─────────│  (no valid cookie)       │
      │                         │                          │
      │── POST /api/auth/login (password) ─────────────────▶│
      │                         │      bcrypt check +      │
      │                         │      sign with secret    │
      │◀─ Set signed cookie (30 days), 303 → / ─────────────│
      │                         │                          │
      │── GET /any-page (with cookie) ─▶│                   │
      │                         │  HMAC-SHA256 verify +    │
      │                         │  issued after the last   │
      │                         │  sign-out-everywhere?    │
      │◀─ 200 ──────────────────│                          │
```

The bcrypt comparison happens only in the login route. The proxy, which runs on
the Node.js runtime in Next 16, verifies the cookie's HMAC with Web Crypto and
checks its issue time against `data/sessions-not-before`.

## A note on scope

Single-password auth is a lock on the front door, not a multi-user permission
system. Everyone who has the password has the same full control: registering
repos, running agents against them, and approving merges. Treat it as protection
for a tool that is yours, exposed somewhere convenient — not as a way to share
one instance with people you would not hand your shell to.
