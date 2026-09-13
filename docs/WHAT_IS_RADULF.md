# What Radulf is

Radulf is a local-first agent loop that turns a task into a reviewable diff.

You describe a coding task against a Git repo on your machine. Radulf's agents
take it from there: one plans the work, one implements it inside an isolated copy
of your repo, and one checks the result against acceptance criteria — sending
concrete failures back to the planner until they hold. What comes back to you
is a diff. You approve it, and Radulf merges.

```
   describe ──▶  plan  ──▶  loop  ──▶  evaluate  ──▶  diff  ──▶  merge
      you          └────── the wolf ──────┘   ▲          you       you
                                │           revise
                                └─────────────┘
```

Your job shrinks to three verbs: **describe** the work, **prioritize** the queue,
and **judge** the diff. Everything in between — planning, coding, testing,
retrying — is the agents' work.

## How much runs without you

The loop is self-driving by degrees, and you pick the degree:

- **Auto Mode** (on by default) claims the next queued task as soon as a loop
  slot frees, so the queue drains without you pressing Start.
- The **evaluator** is the machine gate before you see anything. It runs the
  acceptance criteria and returns concrete failures to the planner; you only get
  handed work it already believes is done.
- **[Improvement Runs](IMPROVEMENT_RUNS.md)** close the last gap. Radulf proposes
  its own next improvement to a repo, drives it end to end on auto-approve, and
  accumulates every approved change on a single branch until the time budget is
  spent. Point it at Radulf's own repo and the tool compounds.

What stays yours: the run is time-boxed and you start it, and the final branch is
still a diff you read. There is no unattended scheduling — that is a deliberate
boundary, not a missing feature.

The lifecycle states (`backlog → todo → in progress → in review → done`) are a
model the orchestrator advances tasks through. They are not lanes you drag cards
between; the UI is an attention-ordered [Work feed](../specs/10-mobile-first-ui.md).

## Where the name comes from

**Radulf** (*RAH-doolf*) is Old Norse *Ráðúlfr*: `ráð` ("counsel, plan") plus
`úlfr` ("wolf"). The wolf that plans. It is also the root of the name "Ralph" —
a nod to the [Ralph Wiggum loop](https://ghuntley.com/loop/) beating at its
core, in which the same prompt is run against a repo over and over with fresh
context each time, and the repo itself is the only memory between iterations.

## What makes it different

**The repo is the memory.** The loop agent starts each iteration with no
recollection of the last one. Everything it needs to continue — the plan, its
progress notes, the code it has already written — is on disk. This is what makes
the loop cheap to restart and hard to derail.

**Nothing runs against your checkout.** Every loop works inside a per-card
`git worktree`, on its own branch. Your working copy is untouched until you
approve a merge, which is the one moment Radulf writes to your repo.

**Agent work is contained by the kernel, not by good intentions.** Agent shell
commands run inside an OS sandbox with a filesystem policy and default-deny
network egress. See [Sandboxing](SANDBOXING.md).

**One harness, any provider.** Every agent role runs through
[pi](https://github.com/earendil-works/pi) in SDK mode, in-process — no
subprocess and no CLIs to install. Your provider choice only decides *auth*, so
you can mix providers per role.

```
   Agent roles              One harness              Providers
   ───────────              ───────────              ─────────
    Planner  ─┐                                    ┌─ Anthropic / Claude  (subscription)
              │                                    ├─ ChatGPT / Codex     (subscription)
    Loop     ─┼──────▶   pi SDK (in-process)  ─────┼─ GitHub Copilot      (subscription)
              │                                    ├─ OpenRouter          (API key)
    Evaluator─┘                                    └─ oMLX                (local)
```

**It can work on itself.** Radulf's own repo is a valid target, so you can point
it at itself and let it write its own improvements. Merging still requires your
approval — that never changes.

## What it is not

Radulf is a single-user tool. There are no accounts, no multi-tenancy, and by
default no network exposure beyond `localhost` (though you can
[put it behind a password](AUTHENTICATION.md) if you want to reach it from
elsewhere). It runs one card at a time — there is no parallelism setting,
because local models want the whole machine's memory.

Its GitHub integration is one thing and no more: once you have approved a diff,
Radulf can push that branch and open a pull request for it instead of merging it
locally. That was deliberately absent for a long time, on the grounds that
approving a merge is the trust boundary and a tool that opened pull requests
would move that boundary onto a remote. What changed is not the boundary but
where it sits — the push happens *after* the same approval that authorizes a
merge, so the pull request is a delivery format, not a way for work to arrive
unvetted. It requires the GitHub CLI, already logged in; Radulf has no GitHub
login of its own. And Radulf never merges the pull request it opens — that is
still a person's decision, on GitHub.

Nothing else about GitHub is integrated: no issue sync, no reading review
comments back into a card, no other forge. And it does not merge anything on its
own, ever, without you saying so.

## Where to go next

- [Getting started](GETTING_STARTED.md) — install it and run your first card.
- [How it works](HOW_IT_WORKS.md) — the card lifecycle and the three agent roles.
- [Providers and models](PROVIDERS.md) — configuring who does what.
