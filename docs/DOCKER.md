# Running in Docker

Radulf ships a [`Dockerfile`](../Dockerfile) and a [`compose.yaml`](../compose.yaml)
so a server install is one image and one volume instead of a Node toolchain and
a service unit. Updating, restarting, and rolling back become `docker compose`
commands, and the in-app **Restart** works under `next start` because Docker's
restart policy brings the container back. The image runs the production build,
`make build` then `next start`, exactly as a host install would.

Linux hosts only. The image has no macOS path, and the sandbox inside it is the
Linux implementation described in [Sandboxing](SANDBOXING.md).

## What the image contains

| Layer | Detail |
|-------|--------|
| **Runtime** | Node 22 on Debian bookworm, the production `.next` build, and `node_modules` pruned to runtime dependencies. |
| **Tools the server shells out to** | `git`, `gh`, `bubblewrap`, `socat`, `ripgrep`, `make`, `sqlite3`, `procps`. These are what the orchestrator, the pull-request path, and the Linux sandbox need. |
| **User** | `node`, uid 1000. Nothing in the container runs as root. |
| **Listener** | `0.0.0.0:3000` inside the container. What the host exposes is decided by the port publish, see [Exposing it beyond localhost](#exposing-it-beyond-localhost). |
| **State** | One volume at `/var/lib/radulf`, see [Where state lives](#where-state-lives). |

The image is also the agent's toolchain. A card that needs `go`, `python3`, or
`cargo` fails inside the sandbox unless the tool is in the image, the same way
it would fail on a host that lacks it. Extend rather than edit:

```dockerfile
FROM radulf:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends golang-go && rm -rf /var/lib/apt/lists/*
USER node
```

Then point `compose.yaml`'s `build` at that Dockerfile, or set `image:` to the
result.

## First run

```bash
git clone https://github.com/lhansen-dev/radulf.git
cd radulf
echo 'RADULF_REPOS_DIR=/srv/repos' > .env     # host dir holding the repos Radulf works on
cp .env.example .env.local                    # optional: auth, origin, provider keys
docker compose up -d --build
docker compose logs -f radulf                 # wait for "Ready", check for sandbox errors
```

Then open <http://localhost:3000>.

Two env files do two different jobs:

| File | Read by | Holds |
|------|---------|-------|
| `.env` | `docker compose`, for the `${...}` references in `compose.yaml` | `RADULF_REPOS_DIR` **required**. `RADULF_BIND` and `RADULF_PORT`, both optional. |
| `.env.local` | The app, unchanged, the same file a host install uses | Everything [`.env.example`](../.env.example) lists: auth hash, allowed origin, proxy header, OpenRouter key. |

Both are gitignored. `RADULF_DATA_DIR` in `.env.local` is ignored under compose:
the container path is pinned so an empty `RADULF_DATA_DIR=` copied from the
example cannot move state out of the volume.

> **Quote the password hash.** `docker compose` expands `$name` inside env
> files, and a bcrypt hash is full of `$`. Write
> `RADULF_AUTH_PASSWORD_HASH='$2b$12$...'` with single quotes, or the hash is
> silently mangled and no password matches. A sourced shell file has the same
> rule, so the quotes are right for a host install too.

## Where state lives

Everything that must outlive a container is under one named volume,
`radulf-state`, mounted at `/var/lib/radulf`:

| Path | Contents |
|------|----------|
| `data/` | SQLite database, transcripts, `auth-secret`, and `pi-agent/` with the subscription logins. Denied to agent bash. |
| `worktrees/`, `plans/`, `runtmp/` | Per-run agent output, derived as siblings of `data/` exactly as on a host. |
| `home/` | The container user's `$HOME`: `gh`'s login and any `.gitconfig`. Denied to agent bash, and on the sandbox's credential denylist. |

`docker compose down` keeps the volume. `docker compose down -v` deletes it,
along with every card, transcript, and login. Back up first, see
[Day to day](#day-to-day).

## Repositories

Radulf works on repositories it can see, so the host directory in
`RADULF_REPOS_DIR` is bind-mounted at `/repos`. Register each one as
`/repos/<name>`, or set **Settings → Repositories → Browsable root** to `/repos`
so the folder picker starts there. The picker defaults to `$HOME`, which inside
the container is the empty `home/` directory above.

Registered paths are container paths. A database moved between a host install
and a container install needs its repositories re-registered.

The container user is uid 1000. Repositories owned by another uid fail with
git's `dubious ownership` error on the first merge. Either match the owner or
set `user:` in a per-host override, see [Per-host overrides](#per-host-overrides).

## Log in a provider

The subscription providers need the same one-time interactive login as a host
install, pointed at Radulf's own agent directory:

```bash
docker compose exec -it radulf radulf-login
```

`radulf-login` is `make login` without `make`: it opens pi against
`data/pi-agent` on the volume. Type `/login`, pick the provider, and quit with
`Ctrl+C` once it reports success. [Providers and models](PROVIDERS.md) explains
why a plain `pi` login lands in the wrong directory.

OpenRouter and a local server need no login. Set the key or base URL on
**Settings → Providers & keys**. A local server running on the Docker host is
reachable from the container as `http://host.docker.internal:<port>`, not as
`localhost`.

## GitHub pull requests

Delivering an approved diff as a pull request shells out to `gh`, which must be
authenticated inside the container. Two ways, both invisible to agent bash
because its environment is an allowlist:

- **A token.** Add `GH_TOKEN=...` to `.env.local`. Nothing is written to disk.
- **An interactive login.** Run `docker compose exec -it radulf gh auth login`.
  The credential persists in `home/` on the volume.

## Per-host overrides

`compose.yaml` is the checked-in shape of the service. Anything specific to
one host goes in `compose.override.yaml` beside it, which compose loads on its
own and git ignores. Three overrides come up:

```yaml
services:
  radulf:
    # Split DNS. A provider or git host on a Tailscale tailnet or an internal
    # domain resolves on the host through systemd-resolved, which containers
    # never see: Docker hands them only the upstream servers. List that
    # resolver first and the normal upstream second. glibc falls through to
    # the second only when the first fails, so both kinds of name resolve.
    dns:
      - 100.100.100.100
      - 192.168.1.1
    # Repositories owned by a uid other than 1000.
    user: "1001:1001"
    # A hard bound on the whole container, since per-run cgroup limits do not
    # apply inside it. Size for the server plus one run.
    mem_limit: 12g
    pids_limit: 4096
```

`docker compose config` prints the merged result, which is the quickest way to
confirm an override took.

## Day to day

| Task | Command |
|------|---------|
| Update to the current checkout | `git pull && docker compose up -d --build` |
| Restart | `docker compose restart radulf`, or **Restart** in the app |
| Follow logs | `docker compose logs -f radulf` |
| Stop, keep state | `docker compose down` |
| Shell inside | `docker compose exec radulf bash` |
| Roll back | `git checkout <tag> && docker compose up -d --build` |

Stopping waits up to 45 seconds so an in-flight run can drain, the same
shutdown path a `SIGTERM` takes on a host.

Migrations run forward at boot and are not reversed by a rollback. Take a
backup before updating. The database is in WAL mode, so copy it through
SQLite rather than with `cp`:

```bash
docker compose exec radulf sqlite3 /var/lib/radulf/data/radulf.db \
  "VACUUM INTO '/var/lib/radulf/data/radulf-backup.db'"
docker compose cp radulf:/var/lib/radulf/data/radulf-backup.db ./radulf-backup.db
```

## Exposing it beyond localhost

`compose.yaml` publishes the port on `127.0.0.1` by default, which keeps the
rule in [`SECURITY.md`](../SECURITY.md): never listen beyond loopback without
authentication. To serve the LAN or sit behind a reverse proxy:

1. Set `RADULF_AUTH_PASSWORD_HASH` in `.env.local`, single-quoted as above, plus
   `RADULF_ALLOWED_ORIGIN` and, behind a proxy, `RADULF_TRUSTED_PROXY_IP_HEADER`.
   [Authentication](AUTHENTICATION.md) covers all three.
2. Set `RADULF_BIND=0.0.0.0` in `.env`, or the proxy's own address.
3. `docker compose up -d`.

Running the image with a bare `docker run -p 3000:3000` skips step 1's
guard entirely and exposes the no-auth default to every interface. Publish on
`127.0.0.1:3000:3000` or configure auth first.

## Security posture

Radulf's containment is its own sandbox around agent bash, not the container.
That sandbox uses bubblewrap and a seccomp filter, and needs three things
Docker's defaults refuse: unprivileged user namespaces, mounts inside them, and
a fresh `procfs`. `compose.yaml` therefore sets `seccomp=unconfined`,
`apparmor=unconfined`, and `systempaths=unconfined` on the service, and drops
every Linux capability to compensate.

What that means in practice:

- **Agent bash** is confined exactly as on a host install. Nothing about the
  sandbox's filesystem, network, or socket policy changes inside the container.
- **The server process** is confined no less than the same process under a
  service unit on the host, which has no seccomp or AppArmor profile at all.
  It is confined less than a default Docker container.
- **Per-run memory and pid limits** are not applied. They come from a per-run
  cgroup that the `node` user cannot create inside the container, so runs are
  bounded by the disk watchdog and wall clocks instead, and the run row
  records `watchdog`. For a hard bound on the whole container, set `mem_limit`
  and `pids_limit` in a [per-host override](#per-host-overrides).

Turning the sandbox off in Settings to avoid the relaxed options is the wrong
trade. It removes the layer that actually contains the agent.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `required variable RADULF_REPOS_DIR is missing a value` | `.env` is missing or does not set it. Point it at the host directory holding your repositories. |
| Boot log says `sandbox preflight failed` with a `bwrap` error | One of the three `security_opt` entries is not in effect. Run `docker compose config` and check they render. Each missing one has its own message: `No permissions to create new namespace` is seccomp, `Failed to make / slave` is AppArmor, `Can't mount proc on /newroot/proc` is the masked system paths. |
| `fatal: detected dubious ownership in repository` | The repository is not owned by uid 1000. See [Repositories](#repositories). |
| Login page never accepts the password | The hash in `.env.local` was not single-quoted and compose expanded its `$` segments. |
| A local provider times out | Its base URL says `localhost`. Use `host.docker.internal` instead. |
| A provider on a tailnet or internal domain fails with `Could not resolve host` | Containers only get the host's upstream resolvers, not its split-DNS routes. Add the `dns:` override from [Per-host overrides](#per-host-overrides). |
| Port already in use | Set `RADULF_PORT` in `.env`. |
