# How Radulf sandboxes agent runs

This is the **implementation reference** for Radulf's containment — how the code
actually confines a loop, and where each piece lives. It complements, rather
than restates, the two other documents:

- [`specs/14-sandboxing.md`](../specs/14-sandboxing.md) — the **design** and threat
  model (why each decision was made, the acceptance-test table, the rollout).
- [`SECURITY.md`](../SECURITY.md) — the **trust model** in one page (what is
  trusted, what the accepted residuals are).

Read those for the *why*. This document is the *what* and *where*.

> **Scope:** macOS is the supported, release-verified platform (Seatbelt via
> `sandbox-exec`). Linux (including WSL2) is best-effort: the sandbox has a
> Linux implementation (bubblewrap + seccomp, unit-tested), but it is not
> release-verified. Everything below is true on macOS; Linux-specific notes are
> called out.

---

## The one-sentence model

**The worktree is the agent's world, per run.** A loop runs a coding agent with
`--dangerously-skip-permissions` — no interactive approval, no deny-list the
model argues with (decision 7) — and three independent layers make that safe by
*construction* instead of by prompt text. The prompt still says "stay in the
worktree, never push"; after this spec those words describe the walls, they are
no longer the walls.

```
┌────────────────────────────────────────────────────────────────┐
│ Radulf server process (TRUSTED: orchestrator, merge, DB)       │
│                                                                │
│  pi session (in-process)                                       │
│  ├─ read/write/edit/grep/find/ls  ← L2: path-guard wrappers    │
│  ├─ web_search    PLANNER ONLY — query-only, capped, logged    │
│  └─ bash ─operations.exec─▶ srt ▶ /bin/bash -c <cmd>           │
│              (loop + evaluator only)  ▲                        │
│                          └ L1: Seatbelt/bwrap+seccomp + proxy  │
│                                                                │
│  L3: layout & hygiene — worktrees out of data/, allowlist env, │
│      git hardening, per-run TMPDIR + caches, resource limits,  │
│      process-group reaping, pre-merge repo integrity check     │
└────────────────────────────────────────────────────────────────┘
```

The two dangerous primitives — **arbitrary command execution** and **network
egress** — never sit in the same role (see [Role split](#role-capability-split)).

---

## The per-run sandbox context

Everything per-run is owned by **one factory**: `createRunSandbox(runId, {cwd,
s})` in [`src/server/sandbox/context.ts`](../src/server/sandbox/context.ts). Each
of the three pipeline entry points (planner in `planningService`, loop in
`orchestrator.runLoop`, evaluator in `evaluationService`) calls it once at run
start and `cleanup()`s in a `finally`.

It returns a `RunSandboxContext`:

| Field | What it is |
|-------|-----------|
| `root` | The run-private scratch root `<data-parent>/runtmp/<runId>/` (contains `tmp/`, `cache/`). |
| `tmpdir` | Run-private `$TMPDIR` (`root/tmp`) — created at start, deleted at end. |
| `cacheRoot` | Run-private package-manager cache root (`root/cache`) the host user never consumes. |
| `pgidFile` | Where each bash invocation records its process-group id — **inside `tmpdir`** so the in-sandbox write is permitted (see [reaping](#process-group-reaping)). |
| `env` | The allowlist agent env (`agentEnv(...)`). |
| `commandPrefix` | Preamble prepended to every agent bash command (ulimits, pgid record, cgroup join on Linux). |
| `srtConfig` | This run's L1 filesystem + network policy — **present only when `sandboxEnabled`** and a `cwd` was passed. Its *absence* is the explicit signal "do not L1-wrap this run." |
| `diskLimitMechanism` | The real disk bound in force, stamped on the run row. |
| `reap()` / `cleanup()` | Kill recorded process groups; then tear down cgroup + delete `root`. |

The context is threaded to the harness via `RunHarnessOpts.runContext` and
consumed in `createRalphSession` / `spawnHook` (`src/server/harness/pi.ts`).

---

## Layer 1 — OS sandbox on agent bash (srt)

Every bash subprocess of a bash-holding role (loop, evaluator) is wrapped in
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)
("srt"), pinned at `0.0.66`. Wiring and policy live in
[`src/server/sandbox/srt.ts`](../src/server/sandbox/srt.ts).

**Wrap point.** Not `spawnHook` (which is synchronous) but pi's own
`operations.exec` extension point — `createSandboxedBashOperations(runConfig)`
srt-wraps each command (`wrapBashCommand`) before delegating to pi's local
shell exec. `shouldSandboxBash(role, srtConfig)` routes only loop/evaluator
through it; the planner has no bash, so L1 never applies to it.

**Session vs. per-call config — the load-bearing quirk.**
`SandboxManager.initialize()` runs **once** at server boot with a maximally
restrictive floor (`denyRead: [$HOME]`, `allowedDomains: []`). Filesystem policy
*is* rebuilt per call from `wrapWithSandbox`'s `customConfig`, but **network
policy is not** — the egress proxy filters against the *session-level* config.
So `wrapBashCommand` calls `SandboxManager.updateConfig(runConfig)` immediately
before `wrapWithSandbox`. The pipeline is **not** strictly serial: cards in
different repos have always run at the same time, and spec 20 allows more than
one card per repo. What keeps this safe is narrower than a serial pipeline. The
wrap-and-`updateConfig` window is serialized by a promise-chain mutex, and a
runtime check refuses a call whose network-policy slice differs from the one
already queued, rather than letting it silently clobber the other run's
allowlist. Today nothing trips that check, because network policy comes from
global settings with nothing per-card or per-role in it. **Making network
policy genuinely per-run is what must not be done casually**: it would turn
that check from dead code into a hard failure, and needs a per-run sandbox
session instead.

### Filesystem policy (`buildFilesystemConfig`)

Read is **deny-then-allow-back**; write is **allow-only**.

| Access | Paths |
|--------|-------|
| **write allow** | the worktree; the run's `$TMPDIR`; the run's cache root; the parent repo's shared `.git` (resolved via `git rev-parse --git-common-dir`, so a linked worktree's pointer file isn't mistaken for it) |
| **write deny** | `<git>/hooks`, `<git>/config`, `<git>/worktrees/*/config` — the code-execution and redirection vectors inside the shared git dir. `<git>/refs`, `<git>/packed-refs`, `<git>/HEAD`, `<git>/worktrees/*/HEAD` — every ref and checkout pointer, so agent git cannot commit, move a branch, or check the worktree out onto another branch. The orchestrator makes every commit from the host. |
| **read allow** | worktree, `$TMPDIR`, cache root, the shared `.git`; system roots (`/usr /bin /sbin /opt /etc`, plus `/Library/Developer /nix /System` on macOS); toolchain roots derived from `PATH`; three named `$HOME` re-allows: `~/.nvm`, `~/.rustup/toolchains`, `~/.cargo/registry` |
| **read deny** | **`$HOME` in full**, Radulf's `DATA_DIR` and `WORKTREES_DIR`, plus a backstop credential denylist |

**Backstop credential denylist** (`credentialBackstopDenylist`) is unioned into
`denyRead` on every run even though `$HOME` is already denied: `~/.ssh`,
`~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`,
`~/.docker/config.json`, `~/.kube`, `~/.config/gcloud`, `~/.cargo/credentials`,
`~/.gnupg`, and the macOS keychain/browser/cookie paths. It is defense in depth
— if a future re-allow widens by mistake, the obvious targets stay closed. The
excluded re-allows (`~/.pyenv`, `~/.cargo/credentials`, `~/Library/Caches`) are
deliberate; adding one back requires a rationale in the spec.

On Linux, the exact `apply-seccomp` executable resolved by srt is also
read-allowed. It runs inside bubblewrap, so denying `$HOME` otherwise hides
the sandbox's own helper when Radulf is installed there. This exemption opens
only the executable, not its parent directory or Radulf's application data.

**`dropRootsThatWouldReopen` — the total-bypass guard.** `PATH`-derived read
roots are untrusted input: a shallow entry like `/bin` has `dirname` `/`, which
under srt's *recursive* read-allow would re-open the entire filesystem and
defeat every deny. This filter rejects any allow-read candidate that is `/` or a
proper ancestor of `$HOME`/`DATA_DIR`/`WORKTREES_DIR`, applied to the whole
`allowRead` list. (This caught a real total-filesystem bypass during Phase 6.)

### Network policy (`buildNetworkConfig` / `parseNetworkAllowlist`)

Default-deny egress. `registry.npmjs.org` is always allowed; the
`sandboxNetworkAllowlist` setting (one domain per line) extends it. Model API
traffic never goes through agent bash — the pi SDK calls providers in-process
— so no model endpoint is in the allowlist.

- The proxy allows by **requested hostname** and does **not** terminate TLS, so
  a permitted domain is a potential domain-fronting path. Every added domain
  widens this; the setting's help text says so.
- **Go-family TLS carve-out (opt-in, default off).** Go's verifier (and
  gh/gcloud/terraform/kubectl) calls `SecTrustEvaluate` → the macOS `trustd`
  mach service, which Seatbelt denies by default — so **every Go HTTPS fetch
  fails under the sandbox even for an allowlisted domain** (curl/npm work
  because they verify against a PEM bundle, not the system verifier; Go on
  darwin ignores `SSL_CERT_FILE`). The `sandboxWeakerIsolationForGoTls` setting
  enables srt's `enableWeakerNetworkIsolation`, which allows `trustd.agent`.
  **Residual:** `trustd` runs outside the sandbox and its OCSP/CRL requests
  bypass the egress proxy — a low-bandwidth exfil channel. Off keeps isolation
  strict; turn it on only for repos whose toolchain needs it.

### Socket policy

- **Unix domain sockets are denied by default** — by *not* setting
  `allowUnixSockets`/`allowAllUnixSockets` (srt's own default is deny-all).
  Re-adding either key is a security regression that needs a rationale in the
  spec, not a quiet edit.
- `/var/run/docker.sock` is therefore unreachable (verified live). Docker-socket
  access is root-equivalent on the host.
- `SSH_AUTH_SOCK` is dropped from the agent env by L3 (denying `~/.ssh` stops
  *reading* the key; the agent socket would let a process *use* it without
  reading — both are required).

---

## Layer 2 — path containment for in-process file tools

srt cannot reach the pi tools that run *inside* the server process. The same
`customTools` mechanism that overrides `bash` overrides **`read`, `write`,
`edit`, `grep`, `find`, `ls`** with thin guard-then-delegate wrappers.

- **Guard:** `guardPath` in
  [`src/server/sandbox/pathGuard.ts`](../src/server/sandbox/pathGuard.ts) — expand
  `~`, resolve against cwd, `realpath` the deepest existing ancestor (so
  not-yet-created write targets resolve and symlinks can't launder), then
  compare by **path segment** (`path.relative`, not string prefix — so
  `<worktree>-evil` is not inside `<worktree>`).
- **Wrappers:** `createGuardedFsTools` in
  [`src/server/harness/guardedTools.ts`](../src/server/harness/guardedTools.ts) —
  guard, then delegate to pi's built-in tool definition (never reimplement).
- **Per-role roots** (`pathRootsForRole` in `pi.ts`):

  | Role | Read roots | Write roots |
  |------|-----------|-------------|
  | Planner | repo checkout (worktree) | `<worktree>/.ralph` only |
  | Loop | worktree | worktree |
  | Evaluator | worktree | worktree (net changes constrained to docs + `.ralph/` by the post-run integrity check, not L2) |

Mutating tools are root-only with no exceptions (not even `.git` — commits go
via bash under L1). Read-side tools are root-only too; the escape hatch for
legitimate outside reads is bash, where the kernel decides. The planner has no
bash and therefore no escape hatch — correct, since a planner needing outside
reads is being manipulated. Its containment is L2 + L3 only, acceptable because
it cannot spawn a process that would escape a JS-level guard.

---

## Layer 3 — layout & hygiene

Cheap, sandbox-independent changes that shrink what a breach can reach. Most
live in [`context.ts`](../src/server/sandbox/context.ts) and
[`src/server/harness/types.ts`](../src/server/harness/types.ts).

### Worktrees & plans out of `data/`

`WORKTREES_DIR` and `PLANS_DIR` are siblings of `data/` (overridable via
`RADULF_WORKTREES_DIR` / `RADULF_PLANS_DIR`), so the L1 policy is simply "deny
`data/`" with no carve-out and a stray `rm -rf ..` is no longer two levels from
`auth.json`. Old runs stored absolute worktree paths and keep resolving.

### Env is an allowlist (`agentEnv`)

The agent's bash env is **constructed from scratch**, not `process.env` minus
known secrets. Included: `PATH`, `HOME`, `LANG`/`LC_*`, `TERM=dumb`, the
run-private `TMPDIR` and package-manager caches, git hardening + a constant
commit identity, and whatever srt's proxy injects. Unknown secrets in the
launching shell stop leaking by default. `SSH_AUTH_SOCK` is excluded by
construction (with a test asserting it never appears).

**Per-run caches** (so a poisoned shared cache can't be executed by the host
outside the sandbox on its next install):
`npm_config_cache`, `npm_config_store_dir`, `YARN_CACHE_FOLDER`,
`XDG_CACHE_HOME`, and — because Go's caches default under `$HOME`
(`~/go`, and `~/Library/Caches/go-build` which `XDG_CACHE_HOME` does *not*
redirect on macOS) — `GOPATH`, `GOMODCACHE`, `GOCACHE`, plus
`GOFLAGS=-modcacherw` so the read-only module cache can be deleted at cleanup.
All point at the run cache root, so home-denied needs no re-allow for these
toolchains.

**Git hardening:** `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`,
`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/false`, `GIT_SSH_COMMAND=/bin/false`,
and a constant `AGENT_GIT_IDENTITY` (needed because the global config is
`/dev/null`). No credential helpers, aliases, or SSH auth path reach agent git.

### Resource limits

- **`ulimit -t` and `ulimit -f`** in the command preamble as cheap
  single-process backstops. Deliberately **not** `ulimit -u` (RLIMIT_NPROC —
  per-UID, would starve the server) or `ulimit -v` (RLIMIT_AS — breaks Go/JVM);
  the reasons are recorded in `buildCommandPrefix` so they aren't reintroduced.
- **Linux:** a per-run cgroup v2 slice
  ([`cgroup.ts`](../src/server/sandbox/cgroup.ts)) with `memory.max`, `pids.max`,
  `io` limits — the only mechanism that bounds a process *tree*.
- **macOS disk** ([`diskWatchdog.ts`](../src/server/sandbox/diskWatchdog.ts)) —
  the default, needs no operator setup:
  - **Watchdog** samples the run's private dirs + volume free space every few
    seconds and fails the run past a threshold (`DEFAULT_MAX_RUN_BYTES` 16 GiB /
    `DEFAULT_MIN_FREE_BYTES` 4 GiB) — reactive, so real headroom. A trip
    finalizes the run and moves the card to Needs Attention with the reason.
  - **Ballast** — a pre-allocated 2 GiB file deleted on the free-space trip so
    the machine stays usable while the run is stopped.
  - **APFS quota (hardened, opt-in)** — an operator can put `WORKTREES_DIR` on
    an APFS volume created with `diskutil apfs addVolume … -quota <size>` for a
    genuine `ENOSPC` ceiling. Auto-detected: `detectMacDiskMechanism` reads
    `diskutil info -plist` and stamps `apfs-quota` when the volume's `TotalSize`
    is below the shared `APFSContainerSize`.
- **`diskLimitMechanism`** on the run row records the real bound: `cgroup`
  (Linux), `apfs-quota` (macOS quota volume), or `watchdog` (macOS default).

### Process-group reaping

srt wraps a *command*; anything backgrounded inside one (`nohup ./thing &`)
outlives it. The command preamble records each detached shell's pgid into
`pgidFile` (which **must** live inside an `allowWrite` root — the run's
`$TMPDIR` — or the in-sandbox write is denied and reaping is inert). At run end
`ctx.reap()` kills each recorded group and verifies it is empty **before** the
integrity check and merge — a surviving process could otherwise plant hooks
after a check that already passed.

### Repo integrity check

[`src/server/integrity.ts`](../src/server/integrity.ts) snapshots the parent repo
at run start (hook file hashes, `.git/config` hash, ref set), then re-checks at
**run end** (after reaping) and again — the hook/config portion — **immediately
before merge** in `approveClaimedRun`, however long the card sat in In Review.
The pre-merge check is the load-bearing one; a violation halts the card to Needs
Attention with the diff of what moved.

The run-end ref comparison skips everything under `refs/heads/ralph/`, which is
the namespace Radulf writes itself: card run branches and improvement-run
feature branches. Every worktree shares one `.git`, so without that a sibling
card's ordinary commit shows up as tampering in this run's snapshot and throws
away a finished run (spec 19). Base branches, `main`, tags and remotes are
still compared, as are hooks and `.git/config`.

### Install-script gate

After an install, the orchestrator enumerates every `preinstall`/`install`/
`postinstall`/`prepare` in the **resolved dependency tree** (structural, never
trusting the env or command string, since CLI flags override env) and diffs it
against a per-repo `approvedInstallScripts` list keyed on `{name, version,
scriptHash}`. Anything unapproved halts the run to Needs Attention with the
verbatim script body; approval runs `npm rebuild` per package and **resumes the
paused run in place** (not a requeue). See
[`installGate.ts`](../src/server/installGate.ts). This is a supply-chain
*awareness* control, not a containment one — and not a model-visible prompt.

---

## Role capability split

Three roles, each the narrowest tool set for its job (`toolsForRole` in
`pi.ts`):

| Role | bash | `web_search` | filesystem |
|------|------|--------------|------------|
| 🧭 Planner | ✗ | ✓ (only role) | repo checkout read-only; `<worktree>/.ralph/` write-only |
| 🔁 Loop | ✓ | ✗ | worktree read-write |
| 🔎 Evaluator | ✓ | ✗ | worktree read-write; net changes outside `.ralph/` limited to the doc allowlist by the post-run integrity check |

The split is the point: the planner can reach the network but not execute
commands; the loop can execute commands but reach the network only through the
L1 registry allowlist. Neither holds both halves of an exfiltration chain.
`web_search` ([`webSearch.ts`](../src/server/harness/webSearch.ts)) is query-only
(no agent-supplied URL), ≤ 256 chars, ≤ 8 calls per planner run, every query in
the transcript. The summarizer role was dropped; the evaluator absorbed its
summary + doc-update duties, with its integrity check narrowed to
"code/git-history immutable, doc-allowlist paths permitted."

---

## Review-surface hardening

The human diff review is the last gate, so it is treated as a security control
(diff API + card UI):

- Invisible/confusable Unicode (bidi override, zero-width, tag chars, curated
  homoglyphs) rendered visibly with a banner —
  [`src/shared/diffSafety.ts`](../src/shared/diffSafety.ts) (Trojan Source class).
- Diff suppression defeated: `worktreeDiff` uses `--no-ext-diff --no-textconv
  --text -c core.excludesFile=/dev/null` so a `.gitattributes` marker or a local
  diff-driver hijack can't hide content; `.gitignore`/`.gitattributes` changes
  get their own loud banner.
- Sensitive-path diffs (sandbox/harness/integrity/install-gate, settings, auth,
  merge path) get a distinct red banner —
  [`src/app/review/[id]/sensitivePaths.ts`](../src/app/review/[id]/sensitivePaths.ts).
  Self-target cards land here by design.

---

## Failure semantics — fail loud, no silent fallback

There is **no** automatic "sandbox unavailable, run unsandboxed" fallback.

- **Startup preflight** (`sandboxPreflight` in `srt.ts`, run once at boot in
  [`src/instrumentation.ts`](../src/instrumentation.ts)): platform support, srt's
  dependency check, and (Linux) the Ubuntu 24.04+ AppArmor
  `kernel.apparmor_restrict_unprivileged_userns` gate — each with a specific
  remediation message. Cached via `initializeSandboxRuntimeOnce`.
- After initialization, a timed sandboxed `true` command verifies that the
  runtime can actually start under the run filesystem policy. A missing or
  hidden helper therefore fails startup before an agent spends tokens retrying
  commands that cannot execute.
- Before its first iteration, a run with `sandboxEnabled` awaits that cached
  result; if not `ok`, the run fails and the card moves to Needs Attention with
  the verbatim error — never proceeds unsandboxed.
- The **one escape hatch** is the `sandboxEnabled` setting (default on). Off →
  a persistent red banner on every page ([`src/app/layout.tsx`](../src/app/layout.tsx))
  and `sandboxed: false` stamped on every affected run row. Neither
  `sandboxEnabled` nor `sandboxWeakerIsolationForGoTls` is model-reachable —
  settings have no tool binding, and the sandbox denies writes to the settings
  store.

Every run row carries `sandboxed` (`1`/`0`) and `diskLimitMechanism` so "was
this run actually contained, and by what" is answerable from the run detail and
analytics.

---

## Settings reference

| Setting | Default | Effect |
|---------|---------|--------|
| `sandboxEnabled` | `true` | The escape hatch. Off runs agent bash unsandboxed (loud banner + `sandboxed: false`). Not model-reachable. |
| `sandboxNetworkAllowlist` | `""` | Extra egress domains, one per line. Registries always included. Each entry widens the domain-fronting residual. |
| `sandboxWeakerIsolationForGoTls` | `false` | macOS opt-in: allow `trustd` so Go-family TLS verification works. Residual: `trustd`'s OCSP/CRL lookups bypass the egress proxy. Not model-reachable. |

All three live in [`src/server/settings.ts`](../src/server/settings.ts) and are set
only via the human-facing `/api/settings` route. The disk-limit env vars
(`RADULF_WORKTREES_DIR`, `RADULF_PLANS_DIR`, `RADULF_DATA_DIR`) are resolved in
[`src/db/index.ts`](../src/db/index.ts).

> **Operational note:** the dev server does **not** hot-reload the srt
> singleton's resolved config. After changing any sandbox setting or sandbox
> code, restart (`POST /api/restart`) so the change takes effect.

---

## How to verify

- **Unit / acceptance tests** (real `sandbox-exec` processes, no mocks):
  [`src/server/sandbox/srt.test.ts`](../src/server/sandbox/srt.test.ts) — the
  acceptance-table rows (read denies, egress denies, raw-socket + docker.sock
  denies, `.git` write denies, a control write that succeeds), plus the Go/TLS
  carve-out and network-regression rows.
  [`src/server/sandbox/sandbox.test.ts`](../src/server/sandbox/sandbox.test.ts) —
  env allowlist, disk watchdog, apfs-quota parsing, pgid placement, reaping.
  [`src/server/sandbox/pathGuard.test.ts`](../src/server/sandbox/pathGuard.test.ts)
  and [`guardedTools.test.ts`](../src/server/harness/guardedTools.test.ts) — L2.
- **Positive control** (the real proof): a full plan→loop→evaluate→review card
  with the sandbox on and `$HOME` denied, including a real dependency fetch,
  passing end to end. Verified live for **Node** (`npm install` against the real
  registry) and **Go** (`go mod tidy` fetching through the proxy allowlist with
  the Go/TLS carve-out on). A sandbox that breaks the happy path is a
  regression, not a security feature.
- `make check` runs the full suite + lint + typecheck + build.

---

## Key file map

| Concern | File |
|---------|------|
| Per-run context factory | `src/server/sandbox/context.ts` |
| L1 policy + srt wrap + preflight | `src/server/sandbox/srt.ts` |
| Disk watchdog / ballast / apfs-quota detection | `src/server/sandbox/diskWatchdog.ts` |
| Linux cgroup slice | `src/server/sandbox/cgroup.ts` |
| L2 path guard | `src/server/sandbox/pathGuard.ts` |
| L2 guarded tool wrappers | `src/server/harness/guardedTools.ts` |
| Agent env allowlist + git hardening | `src/server/harness/types.ts` |
| Role split, tool sets, bash wrap routing | `src/server/harness/pi.ts` |
| `web_search` hardening | `src/server/harness/webSearch.ts` |
| Repo integrity check | `src/server/integrity.ts` |
| Install-script gate | `src/server/installGate.ts` |
| Run lifecycle (watchdog, reaping, integrity, gate) | `src/server/orchestrator.ts` |
| Startup preflight | `src/instrumentation.ts` |
| Settings store | `src/server/settings.ts` |
| Review-surface: Unicode | `src/shared/diffSafety.ts` |
| Review-surface: sensitive paths | `src/app/review/[id]/sensitivePaths.ts` |
| `sandboxEnabled=false` banner | `src/app/layout.tsx` |
