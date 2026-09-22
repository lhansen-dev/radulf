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
to that hostname — for example `RADULF_ALLOWED_ORIGIN=radulf.example.com`.
Mutating requests are accepted only from the page's own origin (the exact host
and port the request was addressed to) and, when set, this one. A page on
another `localhost` port is not the same origin, even though browsers send it
the same cookies.

## How it behaves

Visiting any page without a valid cookie redirects you to `/login`. A successful
login sets a signed session cookie valid for **30 days**. To clear it, `POST
/api/auth/logout`, which redirects back to the login page.

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
store, which means there is no way to revoke one cookie individually.

The kill switch for a leaked cookie is **rotating the secret**: delete
`data/auth-secret` and restart. A fresh secret invalidates every outstanding
cookie at once, including your own.

## Under the hood

```
   Browser              Next.js proxy (edge)         Node runtime
      │                         │                          │
      │── GET /any-page ───────▶│                          │
      │◀─ 302 → /login ─────────│  (no valid cookie)       │
      │                         │                          │
      │── POST /login (password) ──────────────────────────▶│
      │                         │      bcrypt check +      │
      │                         │      read auth-secret    │
      │◀─ Set signed cookie (30 days) ──────────────────────│
      │                         │                          │
      │── GET /any-page (with cookie) ─▶│                   │
      │                         │  HMAC-SHA256 verify      │
      │◀─ 200 ──────────────────│  (Web Crypto)            │
```

The bcrypt comparison and the file I/O happen only in Node runtime modules. The
request proxy verifies the signed cookie using Web Crypto alone, which keeps it
edge-compatible.

## A note on scope

Single-password auth is a lock on the front door, not a multi-user permission
system. Everyone who has the password has the same full control: registering
repos, running agents against them, and approving merges. Treat it as protection
for a tool that is yours, exposed somewhere convenient — not as a way to share
one instance with people you would not hand your shell to.
