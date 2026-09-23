# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary user today:** one platform engineer at IREN who operates this instance from their own workstation. They register repos, write or import tasks, order the queue, and judge the diffs that come back. They check the Work feed and approve diffs from a phone as well as a desktop, so mobile use is real, not theoretical.

**Confirmed next audience:** a small IREN platform team sharing one hosted instance behind the single-password login. That instance is not live yet. When it is, several people will read the same queue and the same Needs Attention list, and concurrent cards become everyday rather than occasional.

The user is a working engineer, fluent in git, Jira, GitLab, and Kubernetes tooling. They do not need the product explained, but they do need to know at a glance what needs them, what is running, and what is queued.

## Product Purpose

Radulf is a local-first agent loop that turns a coding task into a reviewable diff. The user describes a task against a Git repo on the host. A planner agent writes the plan, a loop agent implements it inside an isolated worktree one iteration at a time, and an evaluator agent checks the result against acceptance criteria and sends concrete failures back to the planner until they hold. The user is handed a diff they read, then approve or reject.

The user's job shrinks to three verbs: describe the work, prioritize the queue, judge the diff. Success for a task is an evaluator-cleared diff the human approves and Radulf merges or delivers. Success for the product is a queue that drains without the human babysitting it, while every merge still goes through a person.

## Positioning

- **The repo is the memory.** Each loop iteration starts with fresh context. The plan, progress notes, and code on disk are the only state carried forward, which makes the loop cheap to restart and hard to derail.
- **One harness for every provider.** Every role runs through pi in SDK mode, in-process. Anthropic, ChatGPT, Copilot, OpenRouter, and a local OpenAI-compatible server differ only in auth.
- **Nothing touches the user's checkout.** Every card works in its own git worktree on its own branch, and agent bash runs under kernel-enforced containment.
- **A human judges every merge.** This is a locked decision. Improvement Runs auto-approve cards onto one accumulating feature branch, but that branch is the deliverable a person still reviews before anything reaches the default branch.
- **It can point at itself.** The Radulf repo is a valid target, and Improvement Runs let it propose and land its own changes on a time budget.

## Operating Context

**Jobs this instance does today, confirmed by the user:**

- Drive Jira DEV tickets to a diff: import a DEV issue into a new task, let the pipeline plan, loop, and evaluate, then review and merge or open a pull request.
- Review merge requests report-only: point a card at a local review branch and get a plan review with nothing posted back to the forge.
- Improve Radulf itself with cards and Improvement Runs against this repo.
- Batch repo improvements on a time budget against IREN repos such as cluster-setup, reviewed afterwards as one accumulated branch.

**Epics (spec 24):** one card broken down into child tasks that run in order or in parallel under spec 20's per-repo cap, with Jira child issues as ready-made pieces. Tasks may target different repositories, but nothing coordinates two agents; cross-repo coordination has no design yet.

**Environment:**

- The host is Debian Linux. The sandbox is bubblewrap plus a seccomp filter. Upstream treats Linux as best-effort and macOS as primary; here Linux is the real platform and platform copy must not assume a Mac.
- The day-to-day forge is GitLab at gitlab.mercury.iren.ca. Gitea and Forgejo are also valid delivery targets for IREN. The code only speaks GitHub today, for the provenance link in the rail and for pull-request delivery.
- Jira is iren.atlassian.net. Radulf reads issues into card drafts and never writes to Jira.
- The user works the queue from a desktop browser and from a phone.
- Guides live in the in-app Docs tab. The `specs/` directory is a dated decision log and is never rewritten to match the present.

## Capabilities and Constraints

**Lifecycle.** Tasks move through Backlog, Todo, In Progress, In Review, Needs Attention, and Done. In Progress has visible sub-states for planning, looping, evaluating, and revision cycles, plus a paused state. The home surface is an attention-ordered Work feed answering, in order: what needs me, what is running now, what will run next, what changed recently. It is not a kanban board with lanes.

**Roles.** Planner, loop, evaluator, and scoping. Each has its own provider, model, and reasoning-level picker in Settings, with per-card overrides. There is no summarizer role; the evaluator writes the summary.

**Automation.** Auto Mode claims the next queued task when a slot frees. Improvement Runs propose, drive, and auto-approve cards onto one accumulating branch until a time budget is spent, with a Stop that lets the task in flight finish. There is no unattended scheduling, by design.

**Delivery.** Approve merges the branch locally into the card's base branch, or delivers it as a GitHub pull request per spec 15. GitLab, Gitea, and Forgejo delivery are wanted and undecided.

**Integrations.** Jira issue import into a new task, with the issue's child issues as the tasks of an epic, read-only. GitHub status and pull-request delivery. A folder browser that can register an existing repo or create a fresh one.

**Concurrency.** More than one card per repo can run at once under a per-repo cap. Local-model runs remain serial because the model owns the machine's memory.

**Live state.** The UI updates over a server-sent event stream. Reconnect state must be visible but non-blocking.

**Themes.** The user picks a theme in Settings from a fixed set of dark and light options. Appearance is a user setting, not a brand decision.

**Terminology.** Use Work, task, and queue in navigation and instructions. Board and column are not names of UI containers. The API, database, and code say card. Ralph is the loop persona. The stuck state is Needs Attention.

**Upstream constraint.** This fork must stay mergeable with lhansen-dev/radulf. UI changes should be PR-sized and consistent with upstream so they can go back. Diverge only where IREN's forges, host platform, and team use require it.

## Brand Commitments

- The name is Radulf, pronounced RAH-doolf, from Old Norse Ráðúlfr, the wolf that plans. The wordmark is the ASCII block letters in the README. There is no logo image.
- The desktop rail ends with a provenance link to the upstream GitHub repo, and spec 10 wants it kept unobtrusive and last.
- The existing docs and UI copy speak in plain second person, short declaratives, and an occasional dry aside. They name what the system is doing and why, and they never hide a state behind a spinner.
- MIT licensed. The upstream author is Luke Hansen.

## Evidence on Hand

- `README.md`, `docs/*.md`, and `specs/*.md` are complete, current, and written by the maintainers. `docs/DESIGN_HISTORY.md` says which specs are superseded.
- `benchmarks/` holds repeatable loop-performance fixtures, and the `/benchmarks` and `/analytics` pages render real local run data.
- There are no committed screenshots, no `public/` directory, no logo image, no testimonials, no customer names, and no pricing. Future work must not invent any of these.

## Product Principles

1. **Attention over status.** Reviewable and stuck work is promoted above the queue. The human manages exceptions and priority, not sticky notes.
2. **A person judges every merge.** Automation can propose, plan, implement, and verify. Only a human approves the diff that lands.
3. **Progress is specific.** Active work shows phase, elapsed time, iteration, and recent activity. Never a spinner without context.
4. **Every action is a labelled control that works on a phone and a keyboard.** Drag and hover may enhance, never gate.
5. **Diverge from upstream only where IREN needs it.** Forge, host platform, and team use are the reasons to differ. Style is not.

## Accessibility & Inclusion

Spec 10 sets the bar and it is binding: WCAG 2.2 AA contrast for text and controls; full keyboard and screen-reader operability including queue reordering with the new position announced; visible focus that returns to the invoking control after a sheet closes and moves to a meaningful heading after navigation; accessible names on icon-only actions; dialogs that block background interaction and expose name, role, and state; skeletons or labelled progress instead of content replacement; `prefers-reduced-motion` respected with a non-animated label on every pulsing live state; and a minimum 44 by 44 CSS-pixel target.
