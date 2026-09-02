# 15 — GitHub PR delivery: the approved diff leaves the machine

Decided 2026-09-02. Amends **decision 6** (in-app diff review → Approve-merge)
by adding a second, per-card delivery target for an approved diff: instead of
merging into the local base branch, Radulf pushes the card's branch to `origin`
and opens a pull request. Leaves **decision 8** intact — merging still requires
human approval, and Radulf never merges the pull request it opens.

This spec also overturns a stated product position. `docs/WHAT_IS_RADULF.md`
currently says GitHub integration is absent *"deliberately rather than
pending"*, on the grounds that approving a merge is the trust boundary and a
tool that opened pull requests would move that boundary onto a remote. That
reasoning is answered rather than ignored — see
[Why this does not move the trust boundary](#why-this-does-not-move-the-trust-boundary)
— and the guide is rewritten as part of this spec's work, not left contradicting
the code.

## Motivation

The local merge assumes the operator is the only consumer of the diff. Two
things break that assumption:

1. **Radulf targets repos with collaborators.** A merge straight into local
   `main` is the wrong artifact when the change has to be reviewed by someone
   who does not have the machine Radulf runs on.
2. **The diff is already reviewable elsewhere.** Once the operator has approved
   in In Review, the remaining work — push, open PR, paste a description — is
   mechanical, and doing it by hand throws away the plan and evaluator summary
   Radulf already holds.

## Why this does not move the trust boundary

The original objection was that opening a pull request publishes the agent's
work before a human has vetted it. That is true of a design where the PR is how
work *arrives* for review. It is not true here, because of where the action
sits:

```
 evaluate ──▶ In Review ──▶ [human approves] ──┬──▶ merge to local base   (today)
                                               └──▶ push + open PR        (this spec)
```

The push happens **after** the same human approval that authorizes a merge
today, from the same trusted, unsandboxed code path, after the same pre-merge
repo-integrity check. The human's approval is still the only thing that releases
the diff; this spec only changes what "release" writes to. A PR is a *narrower*
release than a local merge, not a wider one — a local merge puts the commit on
the branch the operator builds from, whereas a PR puts it somewhere a second
human still has to accept.

The genuinely new exposure is that the diff becomes visible to whoever can read
the remote, before that second human accepts it. That is inherent to wanting
pull requests at all, and it is the operator's own repo and own remote. It is
accepted, with one mitigation: see
[Interaction with auto-approve](#interaction-with-auto-approve).

## Threat model delta

Relative to [14](14-sandboxing.md)'s model, which stands unchanged:

- **The agent gains no new reach.** `git push` remains blocked inside the
  sandbox by both mechanisms 14 names (the L1 egress proxy for HTTPS, and the
  socket/exec policy plus `GIT_SSH_COMMAND=/bin/false` for SSH), and
  `~/.config/gh` remains on the deny list. Both of 14's acceptance tests for
  those stay as-is and must keep passing after this spec ships.
- **No tool binding may be added for any of this.** Same rule as
  `sandboxEnabled` and `sandboxWeakerIsolationForGoTls`: the PR toggle, the
  push, and the `gh` invocation are host-side only and structurally unreachable
  from a model. A loop that decides it should open a PR has no way to.
- **New credential in the blast radius: the operator's GitHub auth.** It is
  reached only by the host process, only after human approval, and never enters
  an agent's environment. `gh`'s own credential store stays where the sandbox
  already denies it.

## The decision

**PR delivery replaces the merge.** For a card with PR delivery on, approval
pushes the branch and opens a PR; `mergeBranch` is not called and the local base
branch is untouched. Radulf does not also merge locally — a local merge plus a
PR describing the same change is two sources of truth, and the PR is stale from
the moment the local base is pushed.

Granted the same way auto-approve is granted, and for the same reason (a
workspace-wide default that an individual card can opt into independently):

> effective = `card.openPr || settings.openPr`

read at approval time. The `card.approved` / delivery event records which of the
two granted it, exactly as `card.auto_approved` records `source`.

## Ordering, and what still runs

The approval path keeps every check it has today. Only the final write changes.

```
 human approves
   │
   ├─ 1. claim the review (unchanged)
   ├─ 2. checkRepoIntegrity — hooks/config unchanged since snapshot (unchanged)
   ├─ 3. mergeBaseIntoWorktree — base moved? merge it in first
   │        └─ conflict ──▶ hand back to the loop to resolve (unchanged)
   │
   └─ 4. deliver:
          ├─ merge to local base            (today's path)
          └─ push origin HEAD; gh pr create (this spec)
```

Step 3 is deliberately kept for the PR path. Skipping it would just relocate the
conflict to GitHub, where the operator finds out later and without the existing
hand-back-to-the-loop recovery. A PR should never be opened in a state the
existing machinery could have resolved first.

## Interaction with auto-approve

Auto-approve (workspace-wide since 2026-09-02) and PR delivery compose into a
path with no human in it at all: the evaluator approves, and a branch appears on
a remote other people can read. This is the one combination that genuinely
weakens the position argued above, because the "same human approval that
authorizes a merge today" is not there.

**Decision: a card delivered by PR without human approval opens a draft PR.**
`gh pr create --draft`, chosen on whether this particular approval came from a
human or from auto-approve — not on the card's flags. Cheap to implement, and it
keeps "a non-draft PR from Radulf was seen by a human" true by construction.

## Auth

**Radulf does not implement a GitHub login.** It shells out to `gh` and requires
that `gh` is already authenticated, matching the precedent `make login` sets for
the three subscription providers: interactive OAuth belongs in the operator's
terminal, not in a flow Radulf drives.

- `gh --version` fails → the toggle is unavailable, help text says to install
  `gh`.
- `gh auth status` fails → the toggle is unavailable, help text says to run
  `gh auth login` in a terminal.
- Both checks are cached briefly and re-run when a PR delivery fails, so fixing
  auth in a terminal does not require restarting the app.

Two alternatives were considered and rejected **for now**, both recorded because
the friction here may prove to be worth removing later:

| Option | Why not now |
|---|---|
| An encrypted `ghToken` setting passed as `GH_TOKEN` | Works, and is the natural escape hatch for GitHub Enterprise. Deferred only because it is additive — it can be added later without changing anything this spec decides. |
| Radulf runs the OAuth **device flow** itself | The best UX, and the only option that works when Radulf is driven from a phone via [08](08-hosting-auth.md) — a browser opening on the Mac is useless there. Deferred because it needs a registered GitHub OAuth app, which is a project-level commitment, not a code change. |

Driving `gh auth login` under a PTY and scraping its one-time code from stdout
was considered and **rejected outright**: it adds a PTY dependency, opens a
browser on the wrong machine whenever [08](08-hosting-auth.md) is in play, and
couples Radulf to the exact wording of another tool's interactive prompts.

## Settings & data model additions

| Key | Where | Meaning |
|---|---|---|
| `openPr` (bool, default **false**) | settings | Workspace-wide PR delivery. Live override, read at approval time. Not model-reachable. |
| `openPr` (int, default 0) | `cards` | Per-card opt-in, independent of the global — same relationship `autoApprove` has to its setting. Not seeded from the global. |

No new table. The opened PR's URL is recorded on the delivery event and on the
card summary rather than in a column, since nothing queries it.

## Push mechanics

The details that will actually break if unhandled:

- **`GIT_TIMEOUT_MS` (30s) does not apply.** Its comment explicitly reasons from
  "none of these touch a remote." A push needs its own, longer bound. The
  existing SIGTERM-then-SIGKILL escalation is kept and matters more here, not
  less.
- **`GIT_TERMINAL_PROMPT=0`** on the push, and no inherited stdin. A credential
  helper that decides to prompt must fail, not hang — that escalation path
  exists precisely because a wedged git freezes the single global card slot.
- **No `origin` → the toggle is unavailable**, per repo, with the reason shown.
  Most registered repos are local-only and always will be.
- **Push is `--force-with-lease`-free and never forced.** A rejected
  non-fast-forward is an error surfaced to the operator, not something to
  resolve automatically.
- **The branch is pushed from the worktree**, which already has it checked out.

## Failure semantics

Consistent with 14's "fail loudly, no silent fallback":

- A failed push or a failed `gh pr create` **never falls back to a local merge**.
  The operator asked for a PR; quietly merging instead would be the single worst
  outcome available.
- The card returns to In Review (or Needs Attention) with the failure attached,
  the same way a failed merge does today.
- **A retry path is required.** `retryMerge` exists for a completed loop whose
  merge failed; PR delivery needs its sibling, because auth expiry and rejected
  pushes are the two most likely failure modes of this whole feature and both
  are fixed outside Radulf and then retried.

## Non-goals

- **Merging the PR from Radulf.** The PR is the handoff. Whoever reviews it
  merges it on GitHub.
- **Reading PR review comments back into a card.** A round-trip where reviewer
  feedback becomes loop tasks is a real idea and explicitly out of scope here.
- **Forges other than GitHub.** `gh` is the whole integration. GitLab/Gitea are
  not designed for and not designed against.
- **Any model-reachable surface for pushing, PR creation, or these settings.**
  Permanent, not a phase-one limitation.
- **PR templates, reviewers, labels, milestones.** Title and body from the card
  and evaluator summary; everything else is the reviewer's business.

## Acceptance tests

1. Card with `openPr` off delivers exactly as today; `mergeBranch` is called and
   no `gh` process is spawned.
2. Card with `openPr` on: `mergeBranch` is **not** called, the local base branch
   HEAD is unchanged, and `gh pr create` receives the card's branch and base.
3. Global `openPr` on with a card flag of 0 delivers by PR; the event records
   `global`. Card flag 1 with the global off delivers by PR; the event records
   `card`.
4. Human approval → non-draft PR. Auto-approved delivery → `--draft`.
5. Base branch moved: `mergeBaseIntoWorktree` runs before the push, and a
   conflict hands back to the loop without a PR being opened.
6. Push failure and `gh pr create` failure each leave the card recoverable, with
   the local base branch untouched, and neither falls back to a merge.
7. Repo with no `origin`, missing `gh`, and unauthenticated `gh` each make the
   toggle unavailable with a distinguishable reason.
8. **Regression, from 14:** with this spec shipped, `git push` from inside the
   sandbox still fails over HTTPS *and* over SSH, and `~/.config/gh` is still
   unreadable to an agent. These are 14's existing tests; they must not have
   been loosened to make the host-side push work.

## Amendments to prior specs and docs

- **Decision 6** gains a second delivery target. To be written into
  `00-overview`'s locked-decision list **when this ships**, not before — the
  list records what is true, and this spec is a decision, not an
  implementation.
- **Decision 8** is unchanged and worth restating: Radulf still never merges
  without approval, and now also never merges a pull request at all.
- `docs/WHAT_IS_RADULF.md`'s "It does not integrate with GitHub" paragraph is
  rewritten in the same change that ships this. Until then it stands, correctly,
  as the current behavior.
- `docs/HOW_IT_WORKS.md` step 4 gains the second delivery target alongside the
  auto-approve bypass already documented there.
- [07-roadmap.md](07-roadmap.md)'s deferred bet #7, "GitHub PR mode", is
  answered by this spec.

## Found during implementation (2026-09-02)

**`.ralph/` must be stripped before the push.** This spec missed it. The card's
branch carries `.ralph/` — plan artifacts, loop memory, the evaluator's verdict —
and every review surface excludes it (`worktreeDiff`, `worktreeDiffStat`, and
`worktreeChangedPaths` all pass `:(exclude).ralph`), while `mergeBranch` strips
it before committing. A raw push would therefore publish to a remote precisely
the content the local path takes care to leave out, including content no human
was shown. Delivery drops `.ralph` and commits that removal before pushing, and
does so *after* the base-branch merge so a hand-back to the loop never inherits a
worktree whose memory has been stripped.

**Improvement Runs must be excluded from the workspace toggle.** Also missed by
this spec. Every card an Improvement Run spawns takes the run's
`ralph/improve-*` branch as its base, "so approve-merges fold back into it with
no new merge code". That branch is local-only, so PR delivery does not merely
change the shape of the result — there is nothing on `origin` to open a pull
request against, and the run's whole accumulation model *is* the local merge. A
card whose base branch is an active or past Improvement Run's feature branch
therefore never delivers by pull request, global toggle or not. The setting
describes how the operator's own approved work is delivered, and a run's
internal steps are not that.

**Open question 2 is resolved: the worktree is reclaimed**, exactly as it is
after a merge. Once the push succeeds, `origin` holds the branch, so the local
worktree and branch are no longer the only copy and there is nothing to preserve.

**The retry path already existed.** `retryMerge` routes through the same claim
and delivery step, so a failed push or `gh pr create` retries through it
unchanged; only its name still says "merge". Precondition failures (`gh` missing,
logged out, no `origin`) do not need it at all — they return the card to In
Review, so the operator fixes the precondition in a terminal and clicks Approve
again.

## Open questions

1. **Branch naming on the remote.** Card branches are local-first names. Whether
   they are pushed as-is or prefixed is unresolved. Shipped pushing them as-is.
2. ~~**Worktree lifetime.**~~ Resolved above — reclaimed on success.
3. **Whether the operator wants the local merge as well**, per repo. Decided
   against as a default above; if it turns out to be wanted, it is a third
   delivery target rather than a change to this one.
