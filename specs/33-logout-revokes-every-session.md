# 33: Logout revokes every session

Decided 2026-10-13. Amends [08-hosting-auth.md](08-hosting-auth.md).

## The evidence

A session cookie is a signed expiry date, valid for 30 days, with no
server-side store. Logging out deleted the cookie from one browser and did
nothing about any copy of it: another device, a shared machine, a saved HAR
file. The documented kill switch for a leaked cookie was deleting
`data/auth-secret`, which also makes every stored provider key undecryptable,
because settings encryption derives from the same file. There was also no
control in the UI that logged out at all.

Separately, browser login had been broken outright. The site sent
`Referrer-Policy: no-referrer`, under which a browser sends `Origin: null` on
a native form POST, and the proxy's CSRF check refuses a null origin. The
login page is a native form, so with auth enabled every browser login answered
403. Route tests set their own headers and stayed green.

## Decisions

**1. Logout means sign out everywhere.** It writes the current time to
`data/sessions-not-before`, and a session whose issue time (its expiry less
the fixed 30-day lifetime, so the cookie format is unchanged) is at or before
that stamp is invalid. One cookie cannot be revoked on its own; all of them
can. For a single-operator tool that is the safe reading of "log out".

**2. A file, not process state.** Web and worker processes on one data
directory must agree (spec 25), so the stamp lives beside the secret. The
proxy runs on the Node.js runtime (Next 16) and reads it per request.

**3. The control lives in Settings → General.** A native form, shown only
when authentication is on (`<html data-auth>`, set by the root layout).

**4. `Referrer-Policy: same-origin`.** Same-origin requests keep their real
Origin; other sites still receive no referrer. Allowing `Origin: null`
instead would reopen CSRF, since a sandboxed iframe sends exactly that.

**5. A real browser guards the login.** `make check-browser`, part of
`make check`, signs in through the form, creates a task, and signs out
everywhere in headless Chrome against the production build.
