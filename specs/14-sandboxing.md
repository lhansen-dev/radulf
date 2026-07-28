# 14 — Sandboxing: kernel-enforced containment for the skip-permissions loop

Amends [02](02-architecture.md)'s Safety posture, hardens [13](13-single-pi-sdk-harness.md)'s
Security section, and re-amends **decision 7**. The classic Ralph
skip-permissions posture stands — no permission prompts, no interactive
approval, no deny-list the model can argue with. What changes is what enforces
containment: today it is a worktree cwd plus prompt text ("never push, stay in
the worktree"); after this spec it is the **kernel**. The loop keeps its
freedom inside the boundary; the boundary stops being a suggestion.

## Threat model

Stated once, up front, because every policy decision below is only defensible
relative to it.

**Trusted:** the operator, the host machine, the Radulf server process, the
orchestrator's merge step, the model providers, and any diff a human approves
in In Review.

**Untrusted:** everything the agent ingests — repository contents including
files authored by earlier runs, dependency source and install scripts,
web-search results, and the model's own output. Any of these can carry
instructions.

**Primary threat: prompt injection with host reach.** The loop ingests
arbitrary text and then executes commands with the server user's authority.
The realistic attack is injected text that reads a credential and ships it
somewhere, or that plants code which executes later outside the boundary.

**Equally weighted: accidental destruction.** A confused loop that decides the
fix lives in `~/other-project`, or a hallucinated `rm -rf` path, hits the same
missing wall as a malicious one. Nothing in this spec requires a hostile model.

**Out of scope:** a hostile operator; a compromised host; a malicious model
provider; kernel or hypervisor escapes; and the residual risk that a *merged*
diff is hostile, which is a human-review problem (decision 8, and see
[Hardening the review surface](#hardening-the-review-surface)).

**Explicitly accepted residual:** everything the agent reads reaches the model
provider by construction, because tool output enters the context window.
"Reads don't exfiltrate" in this document means "reads don't reach an
*attacker-chosen* destination." It does not mean reads stay local.

## Why prompt-level containment is not containment

An audit of the current posture (2026-07-19) found that every guardrail short
of the merge step is behavioral, and the agent runs with the server user's full
authority:

1. **Filesystem-wide code execution.** The bash tool spawns as the server's
   user with no restriction, and pi's built-in `read`/`write`/`edit` tools
   accept absolute paths and `~` expansion with no containment to cwd
   (`dist/core/tools/path-utils.js` resolves, never validates). Sandboxing
   bash alone would still leave in-process tools that write anywhere.
2. **The agent works two directories from every secret the app owns.**
   `data/worktrees/<run>` is a sibling of `data/radulf.db` (provider keys in
   the settings table), `data/pi-agent/auth.json` (subscription OAuth tokens),
   and `data/auth-secret` (the cookie-forging key). Spec 13's env scrub
   (checklist #6) closed the `process.env` route; `cat ../../pi-agent/auth.json`
   is still open.
3. **The env scrub is a three-item denylist.** Everything else in the shell
   that launched the server — cloud credentials, GitHub tokens, npm tokens —
   passes through to agent bash.
4. **Unrestricted egress.** Anything readable is exfiltratable, and "never
   push" is unenforceable while the user's git credentials and SSH keys are
   reachable. Prompt injection is the realistic trigger: the loop ingests
   arbitrary repo contents, dependency code, and web-search results.
5. **A worktree shares the parent repo's `.git`.** Agent git commands can
   rewrite refs or install hooks in the *real* repo; a planted hook executes
   later when the orchestrator runs `git merge` in the user's checkout. The
   evaluator-integrity snapshot only inspects the worktree.
6. **Self-target is delayed escalation.** A loop-authored change to Radulf,
   once merged and running, *is* the server. One subtle change past the
   evaluator and the human diff is a full compromise. Spec 13 gated
   self-improvement on env isolation; that gate was necessary, not sufficient.
7. **No resource limits** beyond iteration count and wall clock — nothing
   stops a fork bomb, a filled disk, or a long-running miner inside one
   iteration.
8. **Agent-reachable network primitives outside bash.** `web_search` runs
   in-process, so no bash-level egress policy can see it. Its query string is
   agent-controlled text, which makes it a channel regardless of whether the
   API key is exposed.
9. **Nothing reaps background processes.** A sandbox wraps a *command*; a
   process backgrounded inside one survives it, and survives the run.

## Role capability model

Containment is per-role as well as per-run. A role gets the narrowest tool set
that lets it do its job, so that the two dangerous primitives — arbitrary
command execution and network egress — never sit in the same role.

**Amended (resolved with the user, see docs/PLAN_SPEC_14.md Phase 2a):** the
four-role table below is the original design. The summarizer role was
dropped before implementation — it was the most-capable role (bash + write +
`web_search`) over the most-digested untrusted content, purely to `git diff`
+ write a summary + edit docs. The evaluator, which already judges the
change, absorbed both jobs: it writes `.ralph/SUMMARY.md` every run and, on
`approve` only, may edit an allowlisted set of doc paths. Its integrity check narrows accordingly: `HEAD` moving, or any changed
non-`.ralph` path that is not on the doc allowlist, still rejects the
verdict unconditionally — the judge-can't-edit-the-code guarantee is
unchanged. Three roles ship, not four:

| Role | bash | `web_search` | Filesystem |
|------|------|--------------|------------|
| 🧭 Planner | ✗ | ✓ (only role) | repo checkout **read-only**; `<worktree>/.ralph/` **write-only** |
| 🔁 Loop | ✓ | ✗ | worktree read-write |
| 🔎 Evaluator | ✓ | ✗ | worktree read-write; net tracked changes outside `.ralph/` constrained to the doc allowlist by the post-run integrity check (not L2) |

**The split is the point.** The planner can reach the network but cannot
execute commands. The loop can execute commands but cannot reach the network
except through the L1 allowlist (registries). Neither role holds both halves
of an exfiltration chain.

### Planner containment

The planner reads the target repo to write a plan. It never modifies source.

**Amended (resolved with the user, see docs/PLAN_SPEC_14.md Phase 3):** the
planner's cwd is the run's worktree (created by the orchestrator before
planning starts, same as the loop/evaluator), not a separate `plans/<run-id>/`
directory — `PLAN.md`/`CRITERIA.md`/`PROMPT.md` must live where
`planningService` and the loop actually consume them, `<worktree>/.ralph/`.

- **Repo checkout (the worktree): read-only.** Enforced by the L2 guard on
  `read`, `grep`, `find`, `ls` (scoped to the worktree root) and by the
  absence of `write`/`edit` bindings pointed anywhere inside it.
- **`<worktree>/.ralph/`: read-write, and it is the only writable path.**
  Created by the orchestrator before the planner starts. The guard rejects
  writes to any path outside it.
- **No bash.** The planner has no path to the shared git dir at all — no
  `.git` write root, no way to run `git` itself.
- Because the planner has no bash, L1 does not apply to it. Its containment
  is entirely L2 + L3, which is acceptable precisely because it cannot spawn
  a process that would escape a JS-level guard.

### `web_search` containment

`web_search` is the only agent-reachable network primitive that L1's proxy
structurally cannot see, because it runs in the trusted server process. It is
therefore constrained in the harness rather than at the kernel:

- **Planner only.** Removed from the loop and evaluator tool sets. This is
  the single largest reduction in exfiltration bandwidth in this spec: the
  role that reads dependency source, test output, and its own generated code
  no longer holds a network primitive.
- **Query, not fetch.** The tool takes a search string and returns provider
  results. There is no agent-supplied URL parameter and no
  fetch-this-page follow-up. An agent-chosen URL would be a full GET channel
  to an attacker-chosen host; a query string is a low-bandwidth channel to
  one fixed host.
- **Bounded and logged.** Queries are capped at 256 characters, at most 8 per
  planner run, and every query is written verbatim to the transcript. The cap
  bounds per-call bandwidth; the log makes a run that burned its budget on
  base64-looking strings visible to a human reviewing the card.
- **Server-side egress.** The search provider call originates from the
  trusted process against a pinned host, so it needs no entry in the sandbox
  allowlist and the API key never enters the agent's reach — unchanged from
  spec 13.
- **Documented residual.** A planner that has read an injected instruction
  can still leak up to ~2KB per run through query text to one fixed provider,
  who logs it. This is accepted, not solved. It is bounded, it is recorded in
  the transcript, and it is the reason `web_search` does not travel with
  bash. If the residual ever stops being acceptable, the escalation is to
  drop `web_search` entirely and require the human to paste reference
  material into the card.

## Design: three layers, one boundary

The boundary is per-run: **the worktree is the agent's world.** Three layers
enforce it, each covering what the previous one structurally cannot.

```
┌────────────────────────────────────────────────────────────────┐
│ Radulf server process (trusted: orchestrator, merge, DB)       │
│                                                                │
│  pi session (in-process)                                       │
│  ├─ read/write/edit/grep/find/ls  ← L2: path-guard wrappers    │
│  ├─ web_search    PLANNER ONLY — query-only, capped, logged,   │
│  │                server-side egress to a pinned host          │
│  └─ bash ──spawnHook──▶ srt ▶ /bin/bash -c <cmd>               │
│              (loop + evaluator only)  ▲                        │
│                          └ L1: Seatbelt/bwrap+seccomp + proxy  │
│                                                                │
│  L3: layout & hygiene — worktrees out of data/, allowlist env, │
│      git hardening, per-run TMPDIR + caches, resource limits,  │
│      process-group reaping, pre-merge repo integrity check     │
└────────────────────────────────────────────────────────────────┘
```

### Layer 1 — OS sandbox on agent bash

Every bash subprocess of every bash-holding role (loop, evaluator) is wrapped
in [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)
("srt") — Seatbelt profiles via `sandbox-exec` on macOS, bubblewrap **plus the
seccomp filter** on Linux, with proxy-based network filtering on both.

The integration seam already exists and needs no SDK changes: the custom bash
tool's `spawnHook` receives `{command, cwd, env}` and returns the same shape —
today it swaps `env`; it will now also rewrite `command` to the srt-wrapped
form. pi's `commandPrefix` carries the resource-limit preamble (Layer 3).

**The seccomp filter is a hard requirement on Linux, not an optional extra.**
Bubblewrap alone does not block Unix domain sockets, and Unix sockets are the
standard sandbox bypass (see socket policy below). On Linux, if the filter is
absent, the run fails the same way a missing `bwrap` does.

#### Filesystem policy (per run)

The read policy **inverts** relative to the previous draft. Allow-by-default
with a denylist is the exact pattern audit item 3 rejects for environment
variables, and it fails the same way: it is a list of the secrets we happened
to think of. `~/.npmrc` alone — an auth token, in a process that is allowed to
reach `registry.npmjs.org` — is enough to make the point.

| Access | Paths |
|--------|-------|
| write allow | the run's worktree; the run's private `$TMPDIR`; the run's private package-manager cache root; the parent repo's `.git` **except** the deny list below |
| write deny | `<repo>/.git/hooks/**`, `<repo>/.git/config`, `<repo>/.git/worktrees/*/config` — the code-execution and redirection vectors inside the shared git dir |
| read allow | the worktree; the run's `$TMPDIR` and cache root; system and toolchain roots — `/usr`, `/bin`, `/sbin`, `/opt`, `/etc` (minus the deny list), `/Library/Developer`, `/nix`, `/System` on macOS; the language toolchain roots resolved from `PATH` (node, cargo, go, rustup, JDK install dirs) |
| read deny | **`$HOME` in full**, with narrow re-allows for toolchain state that lives there (`~/.nvm`, `~/.rustup/toolchains`, `~/.cargo/registry` — *not* `~/.cargo/credentials`, `~/.pyenv`, `~/Library/Caches/<toolchain>`); Radulf's data dir and worktree root for other runs; `/proc/*/environ` on Linux |

Defense in depth, not primary defense: the narrow re-allows above are each
paired with an explicit deny for the credential file inside them, so a future
widening of a re-allow cannot silently re-expose a secret. Where the sandbox
implementation resolves overlaps by specificity — a narrower rule beating a
broader one in either direction — this is expressible directly; confirm the
precedence semantics in checklist #1 before relying on it.

The backstop denylist is kept and extended anyway, so that if a re-allow is
ever widened by mistake the obvious targets are still closed: `~/.ssh`,
`~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`,
`~/.docker/config.json`, `~/.kube`, `~/.config/gcloud`, `~/.cargo/credentials`,
`~/.gnupg`, `~/Library/Keychains`, `~/Library/Application Support/<browsers>`,
`~/Library/Cookies`, and any `.env`/`.envrc` outside the worktree.

**Why home-denied is affordable:** the loop's legitimate outside-the-worktree
reads are system headers, installed toolchains, and package sources. Those
live under `/usr`, `/opt`, and toolchain roots, all of which stay readable.
The positive-control acceptance test (below) is what proves this in practice;
if a real card needs a home path the fix is a named re-allow with a rationale
in this table, never a return to allow-by-default.

#### Socket policy

Not previously specified, and the most likely place a "working" sandbox turns
out to be porous.

- **Unix domain sockets are denied by default** — enforced by the seccomp
  filter on Linux and by the Seatbelt profile on macOS.
- **`/var/run/docker.sock` is denied explicitly and permanently.** Access to
  the Docker socket is equivalent to root on the host; no allowlist entry may
  ever re-open it.
- **`SSH_AUTH_SOCK` is dropped from the agent environment by L3, and this is
  deliberate rather than incidental.** Denying `~/.ssh` prevents *reading* the
  key; the agent socket lets a process *use* the key without reading it. Both
  are required. This is recorded here so a future edit to the L3 allowlist
  that "helpfully" restores `SSH_AUTH_SOCK` is recognizable as a security
  regression.
- Any future socket allowance requires an entry in this section with a
  rationale, the same bar as a read re-allow.

#### Network policy

Default-deny egress with a domain allowlist. The structural win stands:
**model API traffic never goes through agent bash** — the pi SDK calls
providers in-process from the server — so the allowlist needs no model
endpoint. And with `web_search` now planner-only, the loop and evaluator hold
no network primitive outside the proxy at all.

Default allowlist: package registries only (`registry.npmjs.org`, plus
per-repo additions). A `sandboxNetworkAllowlist` setting (one domain per line)
extends it; empty means registries only.

This kills the exfiltration and the push-despite-prompt vectors together:
`curl attacker.example` and a hook-planted `nc` die at the proxy, and
`git push` dies at the proxy over HTTPS and at the socket policy over SSH —
two different mechanisms, both tested separately (acceptance tests below).

Residual, stated plainly: the proxy allows by requested hostname and does not
terminate TLS, so a permitted domain is a potential domain-fronting path. With
an allowlist of one registry this is narrow. Every entry an operator adds to
`sandboxNetworkAllowlist` widens it, and the setting's help text says so.

**Go-family TLS (macOS) — opt-in carve-out.** Found live by the Go positive
control: Go's TLS verifier (and gh/gcloud/terraform/kubectl, all built with
Go) calls `SecTrustEvaluate` → the macOS `trustd` mach service, which the
Seatbelt profile denies by default, so **every Go HTTPS fetch fails under the
sandbox even for an allowlisted domain** — `curl`/npm work because they verify
against a PEM bundle, not the system verifier, and Go on darwin ignores
`SSL_CERT_FILE`. The `sandboxWeakerIsolationForGoTls` setting (default **off**)
enables srt's `enableWeakerNetworkIsolation`, which allows `trustd.agent`.
Residual, stated plainly: `trustd` runs *outside* the sandbox and its OCSP/CRL
requests bypass the egress proxy — a low-bandwidth exfil channel (a crafted
cert's OCSP URL is attacker-influenceable), comparable to the accepted
`web_search` residual. Off keeps isolation strict; it is a per-operator,
per-need opt-in, not a default. (Go's module/build caches are separately
redirected out of `$HOME` into the run cache root by L3's env allowlist, so
home-denied needs no re-allow for Go.)

### Layer 2 — path containment for in-process file tools

The OS sandbox cannot reach tools that run inside the server process. The same
`customTools` mechanism that already overrides `bash` overrides **`read`,
`write`, `edit`, `grep`, `find`, `ls`**: thin wrappers around pi's built-in
definitions that resolve the path argument (realpath, after `~` expansion) and
check it against the role's allowed roots before delegating. One shared guard
function, one error shape:

```
Error: path escapes this run's boundary — this role may only touch
<allowed-roots>. Use bash for read-only inspection of system paths.
```

Per-role roots:

| Role | Read roots | Write roots |
|------|-----------|-------------|
| Planner | worktree | `<worktree>/.ralph/` only |
| Loop | worktree | worktree |
| Evaluator | worktree | worktree |

Rules:

- **Mutating tools are root-only, no exceptions.** Not even `.git` — commits
  happen via bash, where Layer 1 governs. The planner has no `.git` root at
  all.
- **Read-side tools are root-only too.** The escape hatch for legitimate
  outside reads is bash, where the kernel — not a JS wrapper — decides. This
  keeps the wrapper trivial instead of re-implementing a read-policy engine
  that must match srt's. The planner, having no bash, has no escape hatch,
  which is correct: a planner that needs to read outside the repo is a
  planner being manipulated.
- **Symlink-safe:** the guard compares realpaths, so a symlink planted inside
  the worktree pointing at `~/.ssh` does not launder a read (checklist #5).
- **Directory-boundary safe:** containment is checked with a path-segment
  comparison, not a string prefix, so `<worktree>-evil` is not inside
  `<worktree>`.

### Layer 3 — layout and hygiene

Cheap, sandbox-independent changes that shrink what a boundary breach can
reach.

- **Worktrees move out of `data/`.** `WORKTREES_DIR` becomes its own root
  (default: `worktrees/` beside `data/`, overridable via
  `RADULF_WORKTREES_DIR`), so the srt policy is simply "deny `data/`" with no
  carve-out for a child directory, and a stray `rm -rf ..` from a worktree cwd
  no longer sits two levels from `auth.json`. Existing runs keep working:
  worktree paths are stored absolute in the DB; only new runs use the new root.

- **Env becomes an allowlist.** `agentEnv()` inverts: instead of deleting
  three known secrets from `process.env`, it constructs a minimal env —
  `PATH`, `HOME`, `TMPDIR`, `LANG`/`LC_*`, `TERM=dumb`, plus the git and
  package-manager variables below and whatever srt's proxy requires
  (checklist #7). Unknown secrets in the launching shell stop leaking by
  default instead of by enumeration. `SSH_AUTH_SOCK` is excluded by
  construction and by an explicit test.

- **Per-run `TMPDIR`.** `TMPDIR` points at a run-private directory created at
  run start and deleted at run end, not the inherited system temp. Shared
  temp is a channel between runs and between the agent and the host, and it
  is the one writable path an attacker can count on existing.

- **Per-run package-manager caches.** `npm_config_cache` (and the pnpm/yarn
  equivalents) point at a Radulf-owned cache root the host user never
  consumes. Writable *shared* caches are a sandbox-to-host escape: `npm
  install` runs untrusted postinstall scripts inside the sandbox, and a
  poisoned `~/.npm/_cacache` is executed by the host on its next install
  *outside* it.

- **Install scripts halt the card into Needs Attention.** See
  [the install-script gate](#the-install-script-gate) below.

- **Git hardening in the agent env:** `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`,
  `GIT_ASKPASS=/bin/false`, `GIT_SSH_COMMAND=/bin/false` — no user or system
  gitconfig, so no credential helpers, no `core.sshCommand`, no aliases reach
  agent git, and no interactive or SSH auth path exists. Commit identity comes
  from `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the same env (checklist #4).

- **Resource limits — cgroups where available, `ulimit` only as a backstop.**
  The previous draft's `ulimit` set was wrong in three ways worth recording
  so they are not reintroduced:

  - `ulimit -u` (`RLIMIT_NPROC`) is **per real UID, not per process tree**.
    Radulf runs as the same user as the agent, so an agent that hits the
    ceiling starves the Node process supervising it. Setting it is a
    self-DoS. It is not used.
  - `ulimit -t` is CPU-seconds **per process**, so a fork bomb of
    short-lived processes walks straight past it.
  - `ulimit -v` (`RLIMIT_AS`) breaks Go toolchains, JVMs, and any modern
    arena allocator that reserves large address ranges it never touches. It
    is the classic source of "works outside the sandbox, mysteriously OOMs
    inside." It is not used.

  What is used: on Linux, a per-run **cgroup v2** slice with `memory.max`,
  `pids.max`, and `io` limits — the only mechanism that bounds a process
  *tree*. `ulimit -t` and `ulimit -f` are kept on both platforms as cheap
  backstops against the single-runaway-process case, with the understanding
  that they are not the primary control. Limits get conservative defaults and
  are not user-facing settings until proven necessary.

  macOS has no cgroup equivalent, so disk is bounded separately. Legacy UNIX
  quotas (`edquota`/`quotacheck`) are **not** an option: they are per-UID, and
  Radulf runs as the same user as the agent, so a quota would throttle the
  server alongside the agent — the same trap as `RLIMIT_NPROC`. Ranked
  alternatives:

  | Option | Hard wall? | Setup cost | Notes |
  |--------|-----------|------------|-------|
  | **APFS volume with a quota** | yes | one-time `sudo`, operator step | Add a volume to the existing container with a quota size. Space stays shared from the container pool — the quota caps allocation rather than reserving a fixed partition — so it costs no disk until used. Writes past the ceiling fail with `ENOSPC`. Worktrees on a different volume from `data/` is fine: `git worktree` uses a pointer file, not hardlinks (unlike `git clone --local`). |
  | **Sparse disk image** (`hdiutil`, `SPARSEBUNDLE`, APFS) | yes | none, no admin | Can be created and destroyed **per run**, which also handles cleanup. Two costs: sparsebundles don't reclaim freed space without `hdiutil compact`, and detach fails while a process holds a file open — which the process-group reaping step above must therefore run *before*. |
  | **Polling watchdog** | no | none | Orchestrator samples worktree size and volume free space every few seconds and fails the run past a threshold. Reactive, not preventive: an agent can write several GB between samples on NVMe, so the threshold needs real headroom. Cross-platform, so it doubles as a Linux backstop alongside cgroups. |
  | **Ballast file** | no | none | Pre-allocate a few GB of dead weight on the volume; delete it on disk-pressure detection. Doesn't stop a fill, but keeps the machine usable while recovering. Complements the watchdog. |

  **Decision:** watchdog + ballast ship as the default, because they need no
  operator setup and cannot fail closed on a fresh install. The APFS volume
  quota is documented in Requirements as the hardened option for operators who
  want a genuine ceiling, and `sandboxed`-style run metadata records which
  mechanism was in force. The sparse image stays a documented alternative for
  per-run isolation; revisit it if per-run teardown cost turns out to be
  cheaper than the watchdog's false-positive rate.

- **Process-group reaping at run end.** srt wraps a *command*; anything
  backgrounded inside one (`nohup ./thing &`) outlives it and outlives the
  run. Each bash invocation runs in its own process group; at run end the
  orchestrator kills the group and, on Linux, everything remaining in the
  run's cgroup, then verifies the group is empty before proceeding. Without
  this, every check below runs against a system where the agent is still
  executing.

- **Repo integrity check — at run end *and* immediately before merge.** The
  orchestrator verifies the parent repo: no hook files appeared or changed
  under `.git/hooks`, `.git/config` unchanged, no refs outside
  `refs/heads/ralph/<this-run-branch>` moved. A violation puts the card in
  Needs Attention with the diff of what moved.

  **Running it only at run end is not sufficient.** The previous ordering was
  agent stops → check passes → *unsandboxed* merge into the user's checkout.
  A surviving process can plant `.git/hooks/post-merge` in that window, and
  the hook fires during the merge the design deliberately leaves trusted. So:
  reap the process group first, check at run end, and re-run the hook/config
  portion of the check immediately before the merge, however long the card sat
  in In Review. The pre-merge check is the load-bearing one; the run-end check
  exists to surface the violation while the context is fresh.

## The install-script gate

`npm install` executes arbitrary code from packages the loop chose. That code
runs inside the L1 boundary, so containment is not the issue — the run-private
cache already closes the poison-the-host-cache path, and everything else a
script does is bounded by the sandbox. What the sandbox *cannot* do is tell
the difference between a legitimate native-module build and a supply-chain
attack, because both look like a build script.

So this is a **supply-chain awareness** control, not a containment one: its job
is to put a human in front of "this install wants to execute code from a
package you haven't approved."

**Mechanism.** Agent installs always run with lifecycle scripts disabled.
Afterwards the orchestrator enumerates every `preinstall`, `install`,
`postinstall`, and `prepare` script in the resolved dependency tree and diffs
that set against a per-repo approved list. If anything is unapproved, the run
**halts and the card moves to Needs Attention**, showing the package name,
version, and the verbatim script body. On approval, the orchestrator runs
`npm rebuild <pkg>` for the approved packages only — per-package granularity
rather than all-or-nothing — records them in the repo's approved list, and
**resumes the paused run**.

**Detection is structural, not textual.** npm CLI flags override environment
config, so `npm_config_ignore_scripts=true` in the agent env does not stop
`npm install --ignore-scripts=false`. Pattern-matching the command string is
similarly weak. The gate therefore inspects the *resolved tree* rather than
trusting either the env or the command, so it fires regardless of how the
install was invoked. If the project moves to pnpm, `onlyBuiltDependencies` is
the native form of the same allowlist and replaces the enumeration step.

**This is not a permission prompt, and decision 7 is intact.** The model never
sees a prompt, is never offered an approve/deny tool, and cannot argue with,
retry past, or negotiate the gate. The run stops the way it stops for any
other failure, and a human decides out-of-band in the card UI — the same
Needs Attention mechanism spec 04 already uses. The distinction that matters
for decision 7 is *interactive approval inside the agent loop*, which this is
not.

**Resume, don't requeue.** Needs Attention today means "you fix it and requeue
to Todo," which would restart the run and discard the loop's progress. The
approval path reuses the existing pause/continue machinery to resume the
paused run in place. This is the one new card-lifecycle behavior in this spec
and is pinned in checklist #11.

## Hardening the review surface

Audit item 6 routes the residual self-target risk to human review, and
decision 8 keeps it there. That makes the diff view a security control, and it
gets treated as one:

- **Invisible and confusable Unicode is rendered visibly.** Bidirectional
  override characters, zero-width characters, and confusable homoglyphs in an
  agent-authored diff are shown as explicit escapes with a warning banner.
  This is the Trojan Source class of attack, and it targets exactly the
  "human reads the diff" gate this design depends on.
- **Diff suppression is impossible.** The diff shown in In Review is generated
  with the agent's `.gitignore` and `.gitattributes` changes disregarded for
  the purposes of *what is listed*, and any modification to those two files is
  itself highlighted. An agent that can hide a file from the reviewer has
  defeated the last gate without touching a sandbox.
- **Sensitive-path diffs are flagged loudly.** A run whose diff touches the
  sandbox policy, `spawnHook`, the L2 guard, settings, auth, or the merge path
  gets a distinct warning in the card UI — not a footnote the reviewer reaches
  by scrolling. Self-target cards are first-class; a self-target card
  rewriting its own containment should be impossible to approve inattentively.
- **`sandboxEnabled` is not model-reachable.** It lives in settings, has no
  tool binding, and the sandbox policy denies writes to the settings store.
  The remaining path to flipping it is a merged self-target diff, which the
  flag above exists to make visible.

## What is deliberately unchanged

- **No permission prompts, ever.** Decision 7's skip-permissions posture is
  preserved exactly; the sandbox is static policy, not interactive approval. A
  denied syscall surfaces to the model as an ordinary failed command in the
  transcript, and the loop routes around it or stalls out like any other
  failure.
- **The merge step.** The orchestrator's `--no-ff` merge into the user's
  checkout is trusted server code and runs unsandboxed, as does all
  bookkeeping git — now guarded by the pre-merge integrity check above.
- **Model traffic** — in-process, keys never in the agent's reach, no change.
- **The self-target rule.** Radulf-on-Radulf cards remain first-class; they
  are exactly why layers 1–3 exist. The residual risk that a *merged* change
  is hostile remains a human-review problem by design (decision 8) — the
  sandbox bounds what a run can do, not what an approved diff can do.

## Failure semantics — fail loudly, no silent fallback

Same posture as provider failures (spec 04): there is **no automatic "sandbox
unavailable, running unsandboxed" fallback.** This is deliberately stricter
than Claude Code's default, which warns and proceeds unsandboxed unless
`failIfUnavailable` is set; a tool that runs unattended should not degrade
quietly.

- srt fails to initialize (missing `sandbox-exec`/`bwrap`, missing seccomp
  filter on Linux, unsupported OS, broken profile after an OS update) → the
  run fails before the first iteration, card → Needs Attention, error surfaced
  verbatim.
- **Startup preflight, not first-command discovery.** Platform support, the
  bubblewrap and seccomp dependencies, and (on Linux) whether unprivileged
  user namespaces are permitted are all checked at server start, with a
  specific remediation message per failure. Discovering this at the first
  bash call of a run means a card sits in Needs Attention for a reason the
  operator has to reverse-engineer.
- One escape hatch exists for operational reality: a `sandboxEnabled` setting
  (default **on**). Turning it off shows a persistent warning banner in the UI
  and stamps `sandboxed: false` into every run row it affects, so an
  unsandboxed run is never mistaken for a contained one — in the run detail or
  in the analytics.
- Layer 2 wrappers and Layer 3 env/hygiene have no off switch; they are not
  platform-dependent and cannot break the way a kernel profile can.

## Platform support

**Scope decision (2026-07-22): macOS is the supported platform; Linux is
best-effort / future, not a release gate.** The Linux implementation below
stays in the tree and is unit-tested, but live Linux verification is out of
scope for the current release — the acceptance table is verified on macOS
only. Revisit Linux when it is picked up as real scope.

- **macOS (Apple Silicon or Intel):** supported, Seatbelt via `sandbox-exec`.
- **Linux:** implemented (bubblewrap + seccomp) but **not release-verified** —
  best-effort until Linux is in scope. The notes below describe the intended
  Linux behavior.
- **Ubuntu 24.04 and later** ship an AppArmor policy that blocks unprivileged
  user namespaces, so bubblewrap does not start. Check with
  `sysctl kernel.apparmor_restrict_unprivileged_userns`; if it returns `1`, an
  AppArmor profile granting `bwrap` the `userns` capability is required. This
  is documented in Requirements **and** detected by the startup preflight with
  the exact remediation, because combining fail-loud with an undocumented
  distro default turns into "Radulf doesn't work" on first run for a large
  fraction of Linux users.
- **WSL2:** same as Linux. WSL1 unsupported (bubblewrap needs kernel features
  it lacks). Native Windows unsupported.

## Settings & data model additions

| Addition | Where | Notes |
|----------|-------|-------|
| `sandboxEnabled` (bool, default true) | settings | the one escape hatch; UI banner when false; not model-reachable |
| `sandboxNetworkAllowlist` (text) | settings | extra domains, one per line; registries always included; help text names the domain-fronting residual |
| `sandboxWeakerIsolationForGoTls` (bool, default **false**) | settings | opt-in, macOS only: allows the `trustd` mach service (srt's `enableWeakerNetworkIsolation`) so Go-family tools (go, gh, gcloud, terraform, kubectl) can verify TLS — their verifier calls `SecTrustEvaluate`, which Seatbelt blocks by default, so every Go HTTPS fetch fails otherwise. Residual: `trustd` runs outside the sandbox and its OCSP/CRL requests bypass the egress proxy — a low-bandwidth exfil channel (accepted, like `web_search`). Not model-reachable. |
| `approvedInstallScripts` (json) | per repo | packages whose lifecycle scripts a human approved, as `{name, version, scriptHash}`; a version or script-body change re-triggers the gate |
| `diskLimitMechanism` (enum) | runs table | `watchdog` \| `apfs-quota` \| `sparse-image` \| `cgroup`; stamped per run so a run's real bound is recoverable later |
| `sandboxed` (bool) | runs table | stamped per run; shown in run detail and analytics |
| `RADULF_WORKTREES_DIR` (env) | db/index.ts | new worktree root, default `worktrees/` beside `data/` |
| `RADULF_PLANS_DIR` (env) | db/index.ts | planner output root, default `plans/` beside `data/` |

## Amendments to prior specs and locked decisions

- **Decision 7 (skip-permissions posture):** re-amended. The posture remains
  structural and prompt-free, but "structure" now means kernel-enforced
  sandbox (filesystem + egress + sockets) plus in-process path guards plus
  per-role capability limits — the worktree cwd and `PROMPT.md` guardrails
  become defense-in-depth rather than the boundary itself. The
  [install-script gate](#the-install-script-gate) is **not** an exception:
  it halts the run into Needs Attention for out-of-band human review and is
  invisible to the model, which is categorically different from an
  interactive approval the agent can see, retry, or argue with.
- **Spec 02 (Safety posture):** the three-bullet posture gains the sandbox as
  its first line; "containment comes from structure, not the permission
  system" now names srt, the tool wrappers, the role capability split, and the
  integrity check.
- **Spec 13 (Security):** its env-isolation fix (option 1, scrubbed spawn env)
  is subsumed — the scrub becomes an allowlist and the spawn hook also applies
  the sandbox wrap. Checklist #6's acceptance test stands and gains the
  filesystem/egress/socket tests below. The worker-thread sandbox (its option
  3) stays deferred; this spec addresses a different boundary (agent vs. host),
  not SDK crash isolation. **`web_search` moves from a shared tool to a
  planner-only tool**, amending 13's tool-injection section.
- **Spec 04 (PROMPT.md contract):** the guardrail bullets ("never push, stay
  inside this worktree") remain in the prompt — they reduce wasted iterations
  banging into denials — but the contract note changes from "containment is the
  worktree + prompt guardrails" to "containment is enforced; the prompt just
  tells you where the walls are."
- **Doc reconciliation alongside the code:** spec 00 index row + decision 7
  note; SECURITY.md trust-model section gains the threat model above and a
  "bounded by the run sandbox" clause; README gains the srt dependency note,
  the Linux support row, and the AppArmor caveat.

## Rollout

1. **Layer 3 first** (env allowlist, git hardening, worktree relocation,
   per-run TMPDIR and caches, process-group reaping, disk watchdog + ballast,
   integrity check at both points) — pure app code, no new dependency,
   immediately shrinks the blast radius, and none of it can break a run that a
   correct loop performs today. The **install-script gate** lands here too: it
   needs the resume path (checklist #11) but no sandbox, and it is the single
   highest-value control against a supply-chain attack that L1 would contain
   but never surface.
2. **Role capability split** (`web_search` → planner only, planner
   read-only/`.ralph`-write, summarizer role dropped) — pure app code, no new
   dependency, and it removes an entire exfiltration channel independent of
   whether L1 ever ships.
3. **Layer 2** (tool wrappers) — pure app code; land with a test card that
   tries to read/write outside each role's roots through each tool and asserts
   the error shape.
4. **Review-surface hardening** — Unicode rendering, diff-suppression
   defeat, sensitive-path flagging. Independent of 1–3 and worth landing
   early, since it protects the gate everything else falls back to.
5. **Spike: srt per-run configuration** — see checklist #1a. This is the one
   unknown that can change L1's shape, so it happens before L1 is scheduled,
   not during it.
6. **Layer 1** (srt) — add the dependency, wire the spawn hook, ship with the
   default policy; run the standing smoke test (spec 07's walkthrough card)
   plus the acceptance tests below on a mac. (Per the 2026-07-22 macOS-only
   scope decision, Linux acceptance is future work, not a gate.)
7. Only after 1–6: re-open self-improvement cards as routine rather than
   gated — spec 13's rollout step 3 gate is upgraded from "env isolation" to
   "this spec's acceptance tests pass". **Done (2026-07-22).** On the macOS-only
   scope, the acceptance mechanisms and both positive controls (Node and Go,
   sandbox on, `$HOME` denied, real dependency fetches) pass, and resource
   limits / ENOSPC / APFS-quota are verified under real disk pressure. The gate
   was never a runtime flag — it was the operational rule "don't queue
   self-target cards until the sandbox acceptance passes." That condition is met,
   so self-target cards are routine.

## Acceptance tests

A work run instructed to attempt each of the following must fail at the stated
layer, and the failure must be visible in the transcript:

| Attempt | Blocked by |
|---------|-----------|
| `cat <data-dir>/pi-agent/auth.json` / open the DB | L1 read deny |
| `cat ~/.npmrc`, `cat ~/.git-credentials`, `cat ~/.aws/credentials` | L1 `$HOME` read deny |
| `cat` an `.env` in a sibling project outside the worktree | L1 `$HOME` read deny |
| `read`/`edit` with an absolute path outside the role's roots | L2 guard |
| `read` a worktree symlink pointing at `~/.ssh/id_ed25519` | L2 realpath guard |
| planner `write` to any path outside `plans/<run-id>/` | L2 guard (planner roots) |
| planner `edit` any file in the repo checkout | L2 guard (no write root in repo) |
| loop or evaluator calling `web_search` | tool not bound for the role |
| `echo $RADULF_AUTH_SECRET`; `env \| grep -i token`; `echo $SSH_AUTH_SOCK` | L3 allowlist env |
| `curl https://example.com` | L1 egress proxy |
| `git push https://…` any remote | L1 egress proxy |
| `git push git@…` any remote | L1 socket/exec policy + `GIT_SSH_COMMAND=/bin/false` — **a different mechanism from the HTTPS case; test both** |
| `nc`/raw socket to a non-allowlisted host | L1 platform layer, not the proxy |
| connect to `/var/run/docker.sock` | L1 socket policy |
| write `<repo>/.git/hooks/pre-commit` | L1 write deny + integrity check |
| move a ref outside `refs/heads/ralph/<run>` | L3 integrity check |
| `nohup sleep 600 &`, then run end | L3 process-group reaping (group empty before checks) |
| plant a hook from a backgrounded process after the run-end check | L3 pre-merge integrity check |
| fork bomb | L3 cgroup `pids.max` on Linux (**not** `ulimit -u`); documented as unbounded on macOS |
| fill the disk with many medium files | L3 watchdog (default) or APFS quota (hardened); `ulimit -f` explicitly does **not** catch this |
| `npm install` of a package with a `postinstall` script | Install-script gate → card halts in Needs Attention with the script body; run **resumes** on approval, does not restart |
| `npm install --ignore-scripts=false` to force scripts | Same gate — detection reads the resolved tree, so the CLI override changes nothing |
| an approved package bumped to a new version with a changed script | Gate re-fires (`scriptHash` mismatch) |
| a diff containing a bidi-override or zero-width character | Review surface: rendered visibly with a banner |
| an agent-authored `.gitignore` that hides a modified file | Review surface: file still listed, `.gitignore` change highlighted |

And one positive control: the spec 07 walkthrough card (plan → loop → evaluate
→ diff), including an `npm install` and a targeted test run, passes end-to-end
**with the sandbox on and `$HOME` read-denied** — a sandbox that breaks the
happy path is a regression, not a security feature. Run it against at least one
Go or JVM repo as well, since those toolchains are where address-space and
home-directory restrictions bite hardest.

## Non-goals

- **Container/VM isolation per run** (Docker/OrbStack/Apple `container`).
  Stronger, but heavier and it fights the worktree design (the shared `.git`
  would need remounting or a clone-based layout). Deferred as a possible
  opt-in "hardened mode"; this spec must land value without a container
  runtime on the host.
- **A dedicated low-privilege OS user** for agent processes — clunky on macOS
  (setuid/launchd), superseded by srt's per-process profiles. Noted, though,
  that a separate UID is the only clean fix for the `RLIMIT_NPROC` problem
  above, so this returns if per-tree process limits ever become necessary on
  macOS.
- **Sandboxing the Radulf server itself** — running the whole app in a VM is a
  deployment choice, orthogonal to this spec, and remains the only mitigation
  for the exposed-port + password scenario (spec 08's domain).
- **A model-visible permission system** — decision 7 stands.
- **TLS-terminating egress inspection** — the proxy allows by hostname
  without inspecting content. Content filtering is a separate tier; the
  mitigation for now is keeping the allowlist to one registry.

## Verification checklist

Pin before Layer 1 ships:

1. **srt library API** — `SandboxManager.initialize(config)` /
   `wrapWithSandbox(command)` shapes against the installed
   `@anthropic-ai/sandbox-runtime` version; config keys
   (`filesystem.allowWrite`/`denyWrite`/`denyRead`/`allowRead`,
   `network.allowedDomains`) and their glob/precedence semantics — in
   particular that a narrow `allowRead` re-opens a path inside a broad
   `denyRead`, and that an exact `denyRead` still wins inside a broad
   `allowRead`, regardless of rule order. The whole home-denied policy depends
   on this being true in the installed version.

   **1a. Spike (blocks rollout step 6): per-run configuration.** Confirm srt
   supports per-invocation config — each run has a different worktree, plan
   dir, TMPDIR, and cache root — without writing a global settings file. If
   config binds at `initialize` time and re-initialization per run is
   expensive or unsupported, L1's integration shape changes, so this is
   answered before L1 is scheduled rather than discovered during it.

2. **Socket policy enforcement** — that the seccomp filter is actually present
   and blocking Unix domain sockets on the target Linux distro, and that the
   macOS Seatbelt profile does the equivalent. Verify `docker.sock` is
   unreachable on a host where Docker is running.

3. **Git-in-worktree minimal write set** — capture (e.g. via `fs_usage` /
   `strace`) the exact `.git` paths `git add/commit/merge/status` touch from a
   worktree and narrow the `.git` write allowance to them; confirm the
   `hooks/`+`config` deny doesn't break any orchestrator-visible git operation.

4. **Commit identity under `GIT_CONFIG_GLOBAL=/dev/null`** — agent commits need
   `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the allowlist env; pin values
   (card/run-derived identity is a nice-to-have, a constant is fine).

5. **Symlink and rename races in the L2 guard** — realpath-then-delegate is
   TOCTOU-imperfect; confirm the residual race is only exploitable by code
   already running (i.e. covered by L1), not by tool input alone. Note this
   reasoning does **not** hold for the planner, which has no L1 underneath it
   — so confirm separately that the planner's roots cannot be raced from tool
   input alone, given the planner cannot spawn a process.

6. **`sandbox-exec` viability** — macOS marks it deprecated but Claude Code
   ships on it; confirm srt's supported-OS story for the local macOS version
   and add it to the upgrade-check ritual alongside pi SDK upgrades (spec 04
   verification note).

7. **Proxy env propagation** — srt's HTTP(S)/SOCKS proxy env vars survive the
   L3 allowlist env (the allowlist must include whatever srt injects), and
   tools that ignore proxy env are actually blocked by the platform layer, not
   merely unproxied. Test explicitly with: raw sockets, a tool with its own
   DNS resolver, and `git push` over SSH. **A passing `curl` test proves
   almost nothing here** — `curl` respects proxy env, which is exactly why it
   is the wrong probe.

8. **Home-denied viability across toolchains** — run the positive control
   against node, Go, Rust, and a JVM repo with `$HOME` denied, and record every
   path that needed a re-allow, with a rationale, in the L1 table. If the list
   grows past roughly a dozen entries, revisit whether home-denied is the right
   default or whether a per-toolchain allow profile is cleaner.

9. **Resource limits under real load** — that the cgroup limits bound a fork
   bomb and a disk-filler without breaking a large linker or test suite. On
   macOS: measure how much a runaway writer lands between watchdog samples on
   an NVMe, and set the threshold headroom from that number rather than
   guessing. Confirm the `diskutil apfs addVolume` quota flag syntax on the
   target macOS version (the Disk Utility GUI exposes it as "Quota Size"; the
   CLI spelling has moved between releases), and confirm a quota-exceeded
   write surfaces as a clean `ENOSPC` in the transcript rather than a hang.

10. **Evaluator under sandbox** — CRITERIA.md commands (test runners, greps)
    pass under the same policy; the evaluator needs no wider access than the
    loop, and specifically does not need `web_search` back.

11. **Needs Attention resume path** — that a card halted by the install-script
    gate resumes the *paused* run on approval rather than requeuing to Todo
    and restarting. This is the first Needs Attention transition that must
    preserve run state; confirm the existing pause/continue machinery covers
    it, and that a run paused mid-iteration by the gate restarts that
    iteration cleanly rather than resuming a half-applied install.

## Risks

| Risk | Mitigation |
|------|-----------|
| Home-denied breaks toolchains in ways the positive control misses | Checklist #8 across four ecosystems; re-allows are named with rationale in the L1 table; failures are loud and per-run, never silent degradation |
| Sandbox breaks legitimate loop work (network installs, odd toolchains) | Positive-control acceptance test; `sandboxNetworkAllowlist`; the install-script gate approves per package and remembers |
| Install-script gate fires constantly and trains the operator to rubber-stamp | Approvals are remembered per repo and keyed on version + script hash, so steady-state repos stop prompting; if a fresh repo fires more than a handful of times, revisit the granularity before revisiting the gate |
| macOS disk fill is unbounded under the default watchdog | Ballast file keeps the machine usable; APFS quota documented as the hardened option; `diskLimitMechanism` stamped per run so "was this run actually bounded" is answerable after the fact |
| srt API/behavior churn (experimental repo) | One integration point (the spawn hook); version pinned; checklist rerun on upgrade — same ritual as the pi SDK |
| srt cannot do per-run config cheaply | Checklist #1a is a spike that runs **before** L1 is scheduled; fallback is a per-run config file in the run dir, or process-level re-init |
| `sandbox-exec` deprecation on macOS | Checklist #6; srt owns the platform abstraction, and bubblewrap covers Linux; container mode is the documented plan-B tier |
| Shared-`.git` write allowance is wider than one branch | `hooks/`+`config` write-denied at L1; every ref and hook checked at run end **and** immediately pre-merge at L3; clone-based layout is the escalation if integrity violations ever fire |
| Planner `web_search` remains a low-bandwidth exfil channel | Query-only (no URL fetch), 256-char cap, 8 calls per run, every query in the transcript; planner holds no bash; documented as accepted residual, with "drop the tool" as the escalation |
| L2 wrappers drift from pi's built-in tool behavior across SDK upgrades | Wrappers delegate to the built-ins (guard-then-forward), never reimplement; pi upgrade checklist gains "wrapper param schemas still match" |
| Resource limits too tight for big repos (linkers, test suites) | Conservative defaults, surfaced in the transcript when hit; `RLIMIT_AS` and `RLIMIT_NPROC` deliberately unused; per-limit tuning stays internal until real cards hit them |
| Fail-loud plus Ubuntu 24.04's AppArmor default reads as "Radulf is broken" | Startup preflight detects it specifically and prints the remediation; documented in Requirements |
| Human review is the last gate and humans skim | Review-surface hardening: visible invisible-Unicode, no diff suppression, loud flags on diffs touching containment code |
| False sense of safety — everything read still reaches the model provider | Stated in the threat model as an accepted residual, not hidden behind "reads don't exfiltrate"; SECURITY.md keeps the "operator trusts the machine" framing |
