# Radulf — Spec Overview

Radulf is a local-first kanban board web app where the cards do their own work.
A card describes a coding task against a local git repo. A frontier agent (on
your Claude subscription by default) turns the card into a plan, a loop agent
executes the plan in a [Ralph Wiggum loop](https://ghuntley.com/loop/) until
it's done. Every agent role — planner, loop, evaluator — runs
through **one harness: pi in SDK mode**, in-process (no subprocess), across all
four providers (Anthropic/Claude and ChatGPT subscriptions, [OpenRouter](https://openrouter.ai/),
and a local [oMLX](https://github.com/jundot/omlx) server); the provider only
determines auth (spec 13). An evaluator agent then checks the diff and runs the
acceptance criteria, sending concrete failures back through the loop before the
result comes back as a human-reviewable diff. Radulf's own repo is a valid
target, so the user can point the app at itself to improve it.

## Spec index

| Doc | Contents |
|-----|----------|
| [01-product.md](01-product.md) | Vision, user, core flows, non-goals |
| [02-architecture.md](02-architecture.md) | System architecture, tech stack, process model |
| [03-data-model.md](03-data-model.md) | SQLite schema and entity lifecycle |
| [04-agent-pipeline.md](04-agent-pipeline.md) | Planning, Ralph loop, evaluator gate, and human review/merge mechanics |
| [05-ui-design.md](05-ui-design.md) | Board layout, card detail, diff review UI |
| [06-self-improvement.md](06-self-improvement.md) | Self-hosting mechanics, Improvement Runs, autonomy boundaries |
| [07-roadmap.md](07-roadmap.md) | Definition of works + post-v1 backlog |
| [08-hosting-auth.md](08-hosting-auth.md) | Internet exposure at radulf.example.com, single-password auth |
| [09-multi-harness.md](09-multi-harness.md) | Loop harness follows the provider: claude-code for subscription, opencode for oMLX/OpenRouter (amends decisions 4/7) |
| [10-mobile-first-ui.md](10-mobile-first-ui.md) | Mobile-first Work feed and responsive screen behavior (amends decision 9's presentation) |
| [11-loop-performance.md](11-loop-performance.md) | Measured loop latency, accurate token/turn telemetry, lean harnesses, orchestrator bookkeeping, and provider/model benchmarks (amends 09's tool-set assumption) |
| [12-pi-harness.md](12-pi-harness.md) | Adds pi as a fourth loop harness and the proxied-provider default (amends 09/11) |
| [13-single-pi-sdk-harness.md](13-single-pi-sdk-harness.md) | One harness — pi in SDK mode — for every provider, subscriptions included (supersedes 09's premise, re-amends decisions 4/7) |
| [14-sandboxing.md](14-sandboxing.md) | Kernel-enforced containment (srt sandbox + tool path guards + layout hygiene) for the skip-permissions loop (re-amends decision 7, hardens 13's Security) |
| [15-github-pr-delivery.md](15-github-pr-delivery.md) | Push + open a GitHub PR as a second delivery target for an approved diff, replacing the local merge (amends decision 6) |
| [16-local-provider-wire-format.md](16-local-provider-wire-format.md) | The local provider is any OpenAI-compatible server, registered over `openai-completions` (amends 12) |
| [17-task-scoping.md](17-task-scoping.md) | A repo-aware scoping session that sharpens a card before planning, closes the planner's questions loop, and can propose a split (extends 04, adds a fourth role to decision 3) |

## Locked decisions

These were decided with the user on 2026-07-10; change only with explicit sign-off.

1. **Task domain** — cards are coding tasks targeting any registered local git
   repo. Radulf itself is just one registered repo.
2. **Stack** — Next.js (App Router) + TypeScript + SQLite (Drizzle ORM +
   better-sqlite3). Single user. No auth on localhost; amended 2026-07-11 by
   decision 10 for internet exposure.
3. **Planning agent** — the user's Anthropic subscription, no raw API key.
   Re-amended 2026-07-17 by [13-single-pi-sdk-harness.md](13-single-pi-sdk-harness.md):
   the client holding the subscription token is now pi (SDK mode), not
   `claude -p`. Frontier-on-subscription stands; only the client changed.
   Amended 2026-09-20 by [17-task-scoping.md](17-task-scoping.md): a fourth
   role, scoping, sits alongside planner, loop and evaluator with its own
   provider, model and reasoning level. It is interactive and read-only, and
   its thread is part of the card the planner receives; the planning agent
   itself is unchanged.
4. **Loop agent** — one harness for every provider: **pi in SDK mode**.
   Re-amended 2026-07-17 by [13-single-pi-sdk-harness.md](13-single-pi-sdk-harness.md)
   (previously, per [09-multi-harness.md](09-multi-harness.md): claude-code for
   the subscription, opencode/pi for the proxied pair). The "subscription OAuth
   is first-party-only" clause is struck — Anthropic now permits subscription
   use through pi (billed per token), and ChatGPT was never restricted. All four
   providers (anthropic/chatgpt subscriptions, OpenRouter, local oMLX) run
   in-process through the pi SDK; the CLI harnesses are retired. oMLX remains
   optional, not required (amended 2026-07-11). Amended 2026-09-19 by
   [16-local-provider-wire-format.md](16-local-provider-wire-format.md): the
   local slot is any OpenAI-compatible server (oMLX, vLLM, LM Studio), spoken to
   over `openai-completions`. The harness is untouched.
5. **Concurrency** — one ticket in the pipeline at a time. A single card runs
   the planner, loop, or evaluator at any moment; the next card starts only once
   that slot frees. Local models own the machine's unified memory, so the queue
   is always serial — there are no parallel loops or planners. Amended
   2026-09-21 by [20-concurrent-cards.md](20-concurrent-cards.md): the slot is a
   per-repo cap (`maxConcurrentCards`, default 1) rather than a constant, held
   at 1 whenever the loop provider is local, which is where this decision's
   stated reason actually applies. One card is still one agent with one
   checklist; nothing splits a card across agents.
6. **Review** — in-app diff review. Loops work in per-card git worktrees on
   per-card branches; the In Review column shows diff + transcript with
   Approve-merge / Reject-with-feedback actions. Amended 2026-09-02 by
   [15-github-pr-delivery.md](15-github-pr-delivery.md): approval has a second
   delivery target, per card or workspace-wide — push the branch to `origin`
   and open a pull request *instead of* merging locally. In-app review remains
   where the diff is judged; only what approval writes to changes. Radulf never
   merges the pull request it opens, so decision 8 is untouched.
7. **Permissions** — the classic Ralph skip-permissions posture. Re-amended
   2026-07-17 by [13-single-pi-sdk-harness.md](13-single-pi-sdk-harness.md): pi
   has no permission system, so the posture is structural — worktree cwd +
   prompt guardrails (the `claude -p --dangerously-skip-permissions` /
   `opencode run --auto` phrasings are historical). Isolation comes primarily
   from the worktree + prompt guardrails, not interactive approval.
   Spec 11 additionally makes unused tool classes unavailable; this preserves
   headless execution while reducing context and accidental scope. `.ralph/DONE`
   is trusted only as the signal to start the evaluator phase; it no longer
   sends a card directly to human review. **Re-amended again by
   [14-sandboxing.md](14-sandboxing.md):** the posture stays structural and
   prompt-free — no permission prompts, no model-visible approve/deny — but
   "structure" now means kernel-enforced containment (an OS sandbox on agent
   bash, in-process path guards on the file tools, and per-role capability
   limits), not just the worktree cwd and prompt text. The worktree +
   `PROMPT.md` guardrails become defense-in-depth rather than the boundary
   itself.
8. **Autonomy** — self-improvement is user-initiated (no cron in v1): the
   user queues cards, including cards against Radulf's own repo, and
   **merging always requires human approval**.
9. **Workflow** — tasks retain the states **Backlog → Todo → In Progress → In Review →
   Needs Attention → Done**, and the orchestrator moves them automatically as
   it works. Amended 2026-07-12 by [10-mobile-first-ui.md](10-mobile-first-ui.md):
   the UI is an attention-ordered Work feed, not five horizontal columns.
   Backlog is never auto-scheduled; Todo is the ordered execution queue.
   Explicit controls are canonical for queueing, starting, restarting,
   reviewing, and queue ordering; drag is an optional desktop enhancement.
10. **Hosting & auth** (added 2026-07-11) — exposed at
    `radulf.example.com` through a reverse proxy (e.g. a K3s Traefik ingress
    with GitOps-managed manifests); the app stays on the Mac. Auth is in-app:
    one password (bcrypt hash in `RADULF_AUTH_PASSWORD_HASH`) → signed
    session cookie, gating every route including the LAN listener. Hash unset
    = today's localhost-only, no-auth behavior. See
    [08-hosting-auth.md](08-hosting-auth.md).

## Glossary

- **Card** — a kanban item describing one coding task with a definition of done.
- **Planning run** — a single frontier pi (SDK) invocation on the subscription
  that turns a card into plan artifacts (`PLAN.md`, `PROMPT.md`, acceptance
  criteria).
- **Ralph loop** — repeated fresh-context pi (SDK) invocations of the same
  prompt against the worktree until its assigned plan tasks are complete or caps
  hit (one harness for every provider — see 13). The repo (plan files, progress
  notes, code) is the only memory between iterations.
- **Evaluation run** — the mandatory agent gate after a loop's DONE signal. It
  is the sole whole-card verifier: it independently inspects the diff, runs
  CRITERIA.md, and writes an approve or revise verdict; revise feedback becomes
  a new loop task.
- **Run** — one orchestrated execution (planning, loop, evaluation, or
  summarization) tracked in the DB with status, artifacts, and transcripts.
- **Worktree** — a `git worktree` checkout under Radulf's data dir where a
  loop operates; the user's main checkout is never touched.
- **Improvement Run** — a user-triggered, time-boxed loop that repeatedly
  proposes one improvement to a target repo and self-drives it (auto-approved)
  through the normal pipeline onto one accumulating feature branch (see 06).
