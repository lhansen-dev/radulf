# 08 — Hosting & Auth

Expose the board at `https://radulf.example.com` with the app still running
on the Mac (it must: it hosts the in-process pi (SDK) agent sessions — holding
the user's pi subscription logins — and, when oMLX is the configured loop
provider, talks to it on localhost).
This assumes a reverse proxy that terminates TLS for `*.example.com` and can
proxy to LAN machines (the worked example below uses a K3s cluster with
Traefik), so hosting is pure reverse-proxy plumbing; the real
work is auth, because **an authenticated Radulf user can run arbitrary code
on the Mac** (skip-permissions loops against registered repos). Auth therefore
lives in the app — the ingress is transport only, and a device on the LAN
faces the same login as the internet.

## Topology

```
Internet ──443──▶ Traefik (K3s cluster)                  Mac
                    │  TLS: cert-manager,                 ┌──────────────────┐
                    │  letsencrypt-prod                   │ Next.js :3000    │
                    └─ Ingress radulf.example.com       │  ├─ auth         │
                         └─ Service radulf (headless) ──┼─▶│  middleware   │
                              └─ EndpointSlice → Mac LAN IP  └─ board / SSE  │
                                                          └──────────────────┘
```

- DNS: `radulf.example.com` → the public IP fronted by your reverse proxy.
- Traefik streams SSE fine with defaults (100 ms flush interval); no
  annotations needed beyond the cert-manager issuer.
- Prerequisite: the Mac gets a DHCP reservation so its LAN IP is stable
  (the EndpointSlice below points at a fixed address).
- The Mac must not sleep while remote access matters (Energy Saver /
  `caffeinate`); that's an ops note, not app logic.

## Cluster side (GitOps manifests)

Raw manifests, not Helm — e.g. an ArgoCD Application with a directory source
pointing at a `manifests/radulf/` path in your GitOps repo. The manifests, in
full:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: radulf
  namespace: radulf
spec:
  clusterIP: None          # headless; no selector — endpoints are manual
  ports:
    - name: http
      port: 3000
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: radulf-1
  namespace: radulf
  labels:
    kubernetes.io/service-name: radulf
addressType: IPv4
ports:
  - name: http
    port: 3000
endpoints:
  - addresses: ["192.168.1.XXX"]   # the Mac's reserved LAN IP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: radulf
  namespace: radulf
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: traefik
  tls:
    - hosts: [radulf.example.com]
      secretName: radulf-tls
  rules:
    - host: radulf.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: radulf
                port:
                  number: 3000
```

## App side: single-password auth

One user, one password, session cookie. No accounts table, no OAuth, no
identity provider.

**Enablement.** Auth is controlled by one env var:

- `RADULF_AUTH_PASSWORD_HASH` — a bcrypt hash. **Set → auth on** and the
  server binds `0.0.0.0`. **Unset → auth off** and the server binds
  `127.0.0.1` (today's localhost-only behavior, preserved exactly — dev stays
  frictionless). Never listen beyond loopback without auth; the pairing is
  enforced, not conventional.
- Generate the hash with a one-liner documented in the README
  (`node -e 'console.log(require("bcryptjs").hashSync(process.argv[1], 12))' -- '<password>'`).
  It lives in `.env.local` on the Mac — not in SQLite, so auth config can't be
  edited from the (authenticated) UI and a fresh checkout is locked by default.

**Login.** `/login` renders a single password field. `POST /api/auth/login`
compares against the bcrypt hash (constant-time by construction) and applies a
fixed 1 s delay on failure plus a small in-memory limiter (5 failures/minute →
429). Success sets the session cookie and redirects to the board.

**Session.** Stateless signed cookie — no session table:

- Value: `<expiresAtMs>.<base64url(hmacSHA256(expiresAtMs, secret))>`.
- The HMAC secret is generated on first boot and persisted to
  `data/auth-secret` (gitignored with the rest of `data/`). Rotating the file
  invalidates all sessions; so does changing it after a password change.
- Cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`, 30-day expiry, refreshed
  on any authenticated page load (sliding). `Secure` is safe alongside local
  use because browsers treat `localhost` as a secure context.
- Logout: a button that clears the cookie. Nice-to-have, not load-bearing.

**Enforcement.** `middleware.ts` gates every route — pages, `/api/*`, and SSE
streams (the cookie rides along on `EventSource` requests natively) — except
`/login`, `/api/auth/login`, and Next's static assets. Verification is
HMAC-only (Web Crypto, edge-runtime-safe); bcrypt runs only in the login route
handler. Unauthenticated: pages redirect to `/login`, API/SSE get `401`.

**CSRF.** `SameSite=Lax` blocks cross-site `POST`s carrying the cookie; as a
backstop the middleware rejects mutating requests (`POST`/`PUT`/`PATCH`/
`DELETE`) whose `Origin` header is present and isn't
`https://radulf.example.com` or a localhost origin.

## Non-goals

- Multi-user, roles, OAuth/OIDC, passkeys — one owner, one password.
- Auth at the ingress (basic-auth middleware, oauth2-proxy) — it would leave
  the LAN listener naked and add a second credential for zero coverage gain.
- Tunnels (Cloudflare, Tailscale funnel) — the cluster already fronts the LAN.
- Running Radulf on the cluster — it needs the user's pi subscription
  login(s), the local repos, and (when configured as the loop provider) oMLX on
  Apple Silicon.

## Threat notes

| Threat | Answer |
|--------|--------|
| Password guessing from the internet | bcrypt cost 12 + 1 s failure delay + 5/min limiter; the password is the single secret, pick it accordingly |
| Stolen/replayed cookie | HMAC-signed, 30-day cap, `Secure`+`HttpOnly`; rotate `data/auth-secret` to kill all sessions |
| LAN device hitting :3000 directly | Same middleware — there is no unauthenticated interface once the hash is set |
| Cross-site request forgery | `SameSite=Lax` + Origin check on mutations |
| TLS | Terminates at Traefik; the Traefik→Mac hop is plain HTTP on the home LAN — accepted at that trust level |
