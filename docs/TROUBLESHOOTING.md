# Troubleshooting

Radulf reports failures as text: an **exit reason** on the run, shown on the card
when it lands in **Needs Attention**, or an error banner in the UI. This page is
keyed on those strings — find the one you were given, in the section for the
stage it came from.

The long explanations live elsewhere; this page links out rather than restating
them.

## Starting a run

**`sandbox unavailable: …`**
The sandbox is enabled but the runtime is not usable on this machine, and Radulf
refuses to fall back to an unsandboxed run silently. The text after the colon is
the preflight's own list — see the two entries below for what it usually says.
The check runs at server boot and is cached, so restart Radulf after fixing it.

**`unsupported platform for sandboxing: <platform>`**
`sandboxEnabled` requires macOS or Linux (including WSL2). Native Windows and
WSL1 are not supported.

**`kernel.apparmor_restrict_unprivileged_userns=1 …`**
The Ubuntu 24.04+ AppArmor default blocks bubblewrap's unprivileged user
namespace. Grant `bwrap` the `userns` capability via an AppArmor profile, or set
the sysctl to `0`, then restart Radulf. Note that Linux is
[best-effort](SANDBOXING.md) — not release-verified.

**`RADULF_AUTH_SECRET is not set`**
Authentication is on but the signing secret is missing. See
[Authentication](AUTHENTICATION.md).

## Providers and models

Radulf preflights the provider before the first iteration rather than
discovering the problem mid-run, so these fail fast.

**`loop provider unreachable: …`**
The loop's provider did not answer. The suffix is the underlying error —
`cannot reach <provider>` for a connection failure, or `<provider> responded
<status>` for an HTTP error.

**`no model selected for the OpenRouter provider — pick one in Settings`**
OpenRouter has no default model; unlike the subscription providers it needs an
explicit model id. See [Providers and models](PROVIDERS.md#configuring-a-role).

**`no model selected for the local provider: …` / `no models available from oMLX`**
No model was configured and the local server offered none to fall back on. It
must already be running and reachable at the configured base URL (default
`http://127.0.0.1:8000`), and the model must be tool-capable.

**`OpenRouter does not serve model "…"` / `the local endpoint does not serve model "…"`**
The model id is not one that provider offers. Check it against the provider's
own model list; the local endpoint's error names everything it is serving.

**`set your OpenRouter API key in Settings first`**
Exactly that — the key is stored in Settings, not in the environment.

**The app says no models are available for a subscription provider.**
Almost always the agent-directory mistake: pi writes `auth.json` wherever
`PI_CODING_AGENT_DIR` points, defaulting to `~/.pi/agent/`, and Radulf only ever
reads `data/pi-agent/`. Running `pi` from your own shell authenticates the wrong
directory. Use `make login` — that is what the target is for. See
[Providers and models](PROVIDERS.md#the-five-providers).

## A card in Needs Attention

Every one of these leaves the worktree intact. You can edit the card or its
plan and restart it, send it back to Backlog, or abandon it.

**`timeout`**
The run hit its wall-clock budget (default 60 minutes, overridable per card).

**`iteration-timeout`**
Two consecutive iterations each exceeded the per-iteration hard timeout. One
timeout is retried with the worktree preserved; the second ends the run.

**`stalled`**
Three consecutive iterations changed nothing — no checklist progress and no
work product. Usually the loop is stuck on a task it cannot express as a file
change, which is a plan problem more often than a model problem.

**`max-iterations`**
The iteration cap was reached (default 50, overridable per card).

**`plan checklist exhausted without a DONE signal`**
The last task finished without the loop signalling completion — typically its
criteria failed. There is no fallback prompt; an empty checklist ends the run.

**`loop failed: …`**
The harness itself errored. Three consecutive failures end the run, and a
first-iteration connection or auth failure ends it immediately, because
retrying a misconfigured provider only spends tokens.

**`repo integrity violation: …`**
The parent repo changed underneath the run in a way the sandbox is supposed to
prevent. This is checked after the process group is reaped and before the
evaluator sees anything. Treat it as a containment failure worth reporting —
see [SECURITY.md](../SECURITY.md).

**`install-script gate: unapproved lifecycle scripts in …`**
A dependency change introduced lifecycle scripts that have not been approved.
Nothing unapproved reaches the evaluator. Review the named packages and approve
them if they are expected.

**`disk watchdog: run is using N GB, over the M GB per-run bound` /
`disk watchdog: volume free space is N GB, under the M GB floor`**
A disk bound tripped and the run was aborted. The bounds and the ballast file
that makes the free-space floor recoverable are described in the README's
disk-limits section.

**`server restarted mid-run`**
Radulf was restarted while the run was in flight. The run is marked interrupted
and the card returns to Needs Attention; restart it.

## Approving a merge

The merge is the one moment Radulf writes to your checkout, so it checks
preconditions first and aborts cleanly rather than leaving a half-merge.

**`target checkout has uncommitted changes`**
The merge target must be clean. The work is not lost — clean the tree, then
`POST /api/cards/:id/retry-merge`.

This is worth watching during an
[Improvement Run](IMPROVEMENT_RUNS.md#gotchas): nothing validates the tree when
the run is created, and the check only fires at the *end* of a card, so a dirty
checkout costs a full plan → loop → evaluate cycle per card and can burn the
whole budget one card at a time.

**`merge conflict — rebase needed: …`**
Recoverable — the branch is stale relative to a base that moved under it. The
card goes back to the loop to rebase rather than dead-ending.

**`cannot checkout <branch>: …` / `merge commit failed: …`**
Something in the target repo blocked the merge. The merge is aborted and your
original branch restored; the git output after the colon is the real cause.

## Improvement Runs

**`proposer ran dry`**
Three consecutive cycles produced no proposal, so the run ended early rather
than burning its remaining budget. Narrowing the focus prompt usually helps.

**`deadline reached`**
The normal ending — the time budget expired.

**Stop is not instant.** The driver only checks the clock between tasks, so a
cycle already in flight finishes first — an observed pass took 8m 42s to wind
down. See
[Improvement Runs](IMPROVEMENT_RUNS.md#stopping-deadlines-and-failure).

## Still stuck

- [Sandboxing](SANDBOXING.md) — what the sandbox allows, and why.
- [Improvement Runs](IMPROVEMENT_RUNS.md#gotchas) — the known rough edges,
  written down.
- [Contributing](../CONTRIBUTING.md) — dev setup, if you want to dig into it.
- [Security policy](../SECURITY.md) — for anything that looks like containment
  failing.
