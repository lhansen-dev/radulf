# Running in Docker

Radulf ships a [`Dockerfile`](../Dockerfile) and a [`compose.yaml`](../compose.yaml)
so a server install is one image, two services, and one volume instead of a
Node toolchain and two service units. Updating, restarting, and rolling back
become `docker compose` commands, and the in-app **Restart** works under
`next start` because Docker's restart policy brings the container back. The
image runs the production build, `make build` then `next start` for the `web`
service and `node dist/worker.mjs` for the `worker` service, exactly as a host
install would, see [Web and worker](#web-and-worker).

Linux hosts only. The image has no macOS path, and the sandbox inside it is the
Linux implementation described in [Sandboxing](SANDBOXING.md).

## What the image contains

| Layer | Detail |
|-------|--------|
| **Runtime** | Node 22 on Debian bookworm, the production `.next` build, and `node_modules` pruned to runtime dependencies. |
| **Tools the server shells out to** | `git`, `gh`, `bubblewrap`, `socat`, `ripgrep`, `make`, `sqlite3`, `procps`. These are what the orchestrator, the pull-request path, and the Linux sandbox need. |
| **User** | `node`, uid 1000. Nothing in the container runs as root. |
| **Roles** | The same image runs as two services. `web` runs `next start` with `RADULF_ROLES=web`, publishes port 3000, and is health-checked with `GET /api/health`. `worker` runs `node dist/worker.mjs` with `RADULF_ROLES=worker`, publishes no port, and is health-checked with `radulf-worker-health`, a script in the image that checks the freshness of the worker's own row in the `workers` table. |
| **Listener** | `0.0.0.0:3000` inside the `web` container. What the host exposes is decided by the port publish, see [Exposing it beyond localhost](#exposing-it-beyond-localhost). |
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
cp .env.example .env.local                    # optional: auth, origin, provider keys
docker compose up -d --build
docker compose logs -f web worker             # wait for "Ready", check for sandbox errors
```

This starts two containers: `web`, which serves the UI, and `worker`, which
runs the agents. The "Ready" line comes from `web`; any sandbox preflight
error comes from `worker`. Then open <http://localhost:3000> and add a
repository by URL, see [Repositories](#repositories).

Two env files do two different jobs, and both are optional:

| File | Read by | Holds |
|------|---------|-------|
| `.env` | `docker compose`, for the `${...}` references in `compose.yaml` | `RADULF_BIND`, `RADULF_PORT`, and `RADULF_REPOS_DIR` for checkouts that already live on the host. |
| `.env.local` | The app, unchanged, the same file a host install uses | Everything [`.env.example`](../.env.example) lists: auth hash, allowed origin, proxy header, OpenRouter key. |

Both are gitignored. `RADULF_DATA_DIR` in `.env.local` is ignored under compose:
the container path is pinned so an empty `RADULF_DATA_DIR=` copied from the
example cannot move state out of the volume.

> **Quote the password hash.** `docker compose` expands `$name` inside env
> files, and a bcrypt hash is full of `$`. Write
> `RADULF_AUTH_PASSWORD_HASH='$2b$12$...'` with single quotes, or the hash is
> silently mangled and no password matches. A sourced shell file has the same
> rule, so the quotes are right for a host install too.

## Web and worker

`compose.yaml` defines two services from the one image. `web` is the HTTP
server: UI, API, and pi login. `worker` is everything that happens in the
background: improvement-run drivers, the schedule tick, and the retention
sweep. All agent work, every git write, and the sandbox happen in the worker;
the web container never runs an agent. Both share the `radulf-state` volume
and the `/repos` mount, so a card the web container creates is picked up by a
worker through the database, and the transcripts and worktrees the worker
writes are served by the web container from the same paths. There is no
`depends_on` between them: each boots on its own against the shared SQLite
file, and the UI stays up while workers restart.

More workers is a scale flag:

```bash
docker compose up -d --scale worker=2
```

Each worker claims cards through the database, and the per-repo pipeline cap
holds across workers, so two workers never run the same card and never exceed
the cap for one repository between them. `--scale web=2` is not the same
shape: only one container can hold the published port, so a second web
container needs a port range in the publish or a reverse proxy in front.

A worker killed mid-run, whether by `docker kill`, an OOM, or a host reboot,
leaves its heartbeat row in the `workers` table to go stale. After
`workerStaleSeconds` (**Settings → Runs**) a surviving worker reaps it and
resumes the card, the same recovery a host install performs after a crash.

To exercise the whole thing without touching a real install:

```bash
make check-compose
```

This brings up one web and two workers under the project name `radulf-check`
with a scratch env file, waits until every container reports healthy, shows
`docker compose ps`, and tears the lot down with `-v`. It creates and removes
its own volumes only, on its own port (`RADULF_CHECK_PORT`, default 3999), and
`compose.check.yaml` drops the fixed OAuth callback ports, so the operator's
`radulf-state` volume and published ports are never involved and the check
runs beside a live stack.

## Where state lives

Everything that must outlive a container is under one named volume,
`radulf-state`, mounted at `/var/lib/radulf`:

| Path | Contents |
|------|----------|
| `data/` | SQLite database, transcripts, `auth-secret`, and `pi-agent/` with the subscription logins. Denied to agent bash. |
| `repos/` | Repositories added by URL. Radulf clones them here. Denied to agent bash like `data/`; a run reaches its own repo's `.git` through the same carve-out as on a host. |
| `worktrees/`, `plans/`, `runtmp/` | Per-run agent output, derived as siblings of `data/` exactly as on a host. A worktree of a repository whose checkout carries a `node_modules` gets a full copy of it at creation, because hard links cannot cross from a bind mount into the volume; budget the install's size per card in flight. The retention sweep reclaims it with the worktree. |
| `home/` | The container user's `$HOME`: `gh`'s login and any `.gitconfig`. Denied to agent bash, and on the sandbox's credential denylist. |

`docker compose down` keeps the volume. `docker compose down -v` deletes it,
along with every card, transcript, and login. Back up first, see
[Day to day](#day-to-day).

## Repositories

The usual way in a container is to add a repository by URL. Open
**Settings → Repositories → Add repository**, or **Add a repository…** in the
task dialog, and paste a clone URL into **Clone from URL**. Radulf clones it
into `repos/` on the state volume and registers it. No mount, no restart. The
name comes from the URL, the default branch from the remote, and because the
clone has an `origin`, pull-request delivery is available for it straight away.

Private repositories need the container user's own git credentials, which
never reach agent bash. For HTTPS, log `gh` in once and let it act as git's
credential helper:

```bash
docker compose exec -it worker gh auth login
docker compose exec -it worker gh auth setup-git
```

Both persist in `home/` on the volume, which both services mount, so a login
done in either container is seen by both. For SSH URLs (`git@host:…` or
`ssh://`), the container needs a private key the git host knows and that
host's entry in `known_hosts`, both under `home/.ssh`. The narrowest way in
is to bind-mount just those two files from the host, read-only, in a per-host
override for both services, see [Per-host overrides](#per-host-overrides); a
deploy key made for Radulf is better than a personal one. Git runs `ssh` in
batch mode, so a host missing from `known_hosts` fails with `Host key
verification failed` rather than prompting: connect to it from the host once
first. A clone that would prompt for a credential likewise fails in seconds
with git's message rather than hanging.

Checkouts that already live on the host can still be mounted: set
`RADULF_REPOS_DIR` in `.env` to the directory holding them, and they appear at
`/repos`. Register each as `/repos/<name>`, or point
**Settings → Repositories → Browsable root** at `/repos` so the folder picker
starts there. Bind-mounted files must be owned by uid 1000, or git fails with
`dubious ownership` on the first merge; either match the owner or set `user:`
in a per-host override, see [Per-host overrides](#per-host-overrides).

Registered paths are container paths. A database moved between a host install
and a container install needs its repositories re-registered.

## Log in a provider

Use the app: **Settings → Providers & keys**, then **Sign in**. Radulf drives
pi's login itself (spec 23), so a container install needs no terminal for
this. What each provider asks for differs, and only one kind cares that
Radulf is in a container.

Anthropic and Codex hand you a link and then wait for a redirect to
`http://localhost:53692/callback` or `http://localhost:1455/auth/callback`.
Those ports are pi's own, fixed and not configurable, and in your browser
`localhost` is the Docker host rather than the container. So compose publishes
both on loopback and sets `PI_OAUTH_CALLBACK_HOST`, which pi needs because it
otherwise binds the container's own loopback, where Docker cannot forward
anything. With a browser on the Docker host the redirect then lands on pi
directly, the paste box withdraws itself, and the login finishes with nothing
to copy. The cost is that those two host ports stay held for as long as the
container runs, so a host install of pi cannot log in beside it.

With the browser on another machine that redirect still fails, which is
expected. Paste the whole URL it failed on into the box, including its `state`,
and never the code alone: pi reads the verifier from the `state`, and a bare
code is exchanged against whichever login is current, which Anthropic rejects
as `Invalid 'code' in request`.

Copilot, Kimi, Meta and xAI use device codes and need no callback at all.
OpenRouter and Radius cannot use the published ports, the first because it
binds an ephemeral port and the second because it hardcodes the container's
loopback, so both keep the paste box wherever the browser is.

A terminal still works, and is the only option with no browser to hand:

```bash
docker compose exec -it web radulf-login
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
- **An interactive login.** The same `gh auth login` as under
  [Repositories](#repositories). The credential persists in `home/` on the volume.

## Per-host overrides

`compose.yaml` is the checked-in shape of the service. Anything specific to
one host goes in `compose.override.yaml` beside it, which compose loads on its
own and git ignores. Four overrides come up:

Overrides are per service: the same block under `worker:` applies to the
worker containers, and DNS or `user:` usually belong on both.

```yaml
services:
  worker:
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
    # apply inside it. Size for one worker plus the runs it drives.
    mem_limit: 12g
    pids_limit: 4096
    # SSH clone URLs: the one key the git host knows and the host's
    # known_hosts, read-only. Create home/.ssh on the volume first
    # (`docker compose exec worker mkdir -p -m 700 /var/lib/radulf/home/.ssh`)
    # so Docker does not create it root-owned. Agent bash never sees $HOME.
    volumes:
      - ~/.ssh/id_ed25519:/var/lib/radulf/home/.ssh/id_ed25519:ro
      - ~/.ssh/known_hosts:/var/lib/radulf/home/.ssh/known_hosts:ro
  web:
    dns:
      - 100.100.100.100
      - 192.168.1.1
    user: "1001:1001"
    volumes:
      - ~/.ssh/id_ed25519:/var/lib/radulf/home/.ssh/id_ed25519:ro
      - ~/.ssh/known_hosts:/var/lib/radulf/home/.ssh/known_hosts:ro
```

`docker compose config` prints the merged result, which is the quickest way to
confirm an override took.

## Day to day

| Task | Command |
|------|---------|
| Update to the current checkout | `git pull && docker compose up -d --build` |
| Restart the server | `docker compose restart web`, or **Restart** in the app |
| Restart the workers | `docker compose restart worker` |
| Follow logs | `docker compose logs -f web worker` |
| Stop, keep state | `docker compose down` |
| Shell inside | `docker compose exec web bash`, or `docker compose exec worker bash` |
| Add workers | `docker compose up -d --scale worker=2` |
| Roll back | `git checkout <tag> && docker compose up -d --build` |

Stopping a worker waits up to 45 seconds so an in-flight run, or a review
delivery it has claimed, can drain — the same shutdown path a `SIGTERM` takes
on a host. If the window elapses with work still active, the worker hands it
back before exiting: it interrupts its own runs (a checkpointed loop goes
straight back to Ready), fails its own running delivery, frees its repo lease
and deletes its `workers` row, so a replacement worker picks the card up on its
first pump rather than after `workerStaleSeconds`.

Migrations run forward at boot and are not reversed by a rollback. Take a
backup before updating. The database is in WAL mode, so copy it through
SQLite rather than with `cp`:

```bash
docker compose exec web sqlite3 /var/lib/radulf/data/radulf.db \
  "VACUUM INTO '/var/lib/radulf/data/radulf-backup.db'"
docker compose cp web:/var/lib/radulf/data/radulf-backup.db ./radulf-backup.db
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
`apparmor=unconfined`, and `systempaths=unconfined` on the `worker` service
only, and drops every Linux capability to compensate. The `web` container
keeps Docker's default seccomp and AppArmor profiles: it never runs an agent,
so it has no sandbox to make room for. Both services drop every capability.

What that means in practice:

- **Agent bash** is confined exactly as on a host install. Nothing about the
  sandbox's filesystem, network, or socket policy changes inside the container.
- **The worker process** is confined no less than the same process under a
  service unit on the host, which has no seccomp or AppArmor profile at all.
  It is confined less than a default Docker container.
- **The web process** is confined exactly as a default Docker container is,
  with every capability dropped on top.
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
| `git clone failed: ... could not read Username` or `Permission denied (publickey)` | The container has no credential for that remote. See [Repositories](#repositories). |
| `worker` log says `sandbox preflight failed` with a `bwrap` error | One of the three `security_opt` entries on the `worker` service is not in effect. Run `docker compose config` and check they render. Each missing one has its own message: `No permissions to create new namespace` is seccomp, `Failed to make / slave` is AppArmor, `Can't mount proc on /newroot/proc` is the masked system paths. |
| `fatal: detected dubious ownership in repository` | The repository is not owned by uid 1000. See [Repositories](#repositories). |
| Login page never accepts the password | The hash in `.env.local` was not single-quoted and compose expanded its `$` segments. |
| A local provider times out | Its base URL says `localhost`. Use `host.docker.internal` instead. |
| A provider on a tailnet or internal domain fails with `Could not resolve host` | Containers only get the host's upstream resolvers, not its split-DNS routes. Add the `dns:` override from [Per-host overrides](#per-host-overrides). |
| Port already in use | Set `RADULF_PORT` in `.env`. With `--scale web=2`, see [Web and worker](#web-and-worker). |
| A `worker` container is `unhealthy` | `radulf-worker-health` found its heartbeat row in the `workers` table stale or missing. Check `docker compose logs worker` for a boot failure; the database must be reachable on the shared volume. |
