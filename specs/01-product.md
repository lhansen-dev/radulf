# 01 — Product

## Vision

A kanban-inspired task workspace where starting a task is delegating work, not
recording it. The user's job shrinks to three verbs: **describe** (write a card), **prioritize**
(order the queue), and **judge** (approve or reject a diff). Everything between
— planning, coding, testing, retrying — is done by agents: expensive frontier
intelligence for the thinking, and whichever provider you choose for the
grinding (Claude subscription by default; OpenRouter or free local oMLX
inference optional).

The long-term bet: once the pipeline works for arbitrary repos, point it at
Radulf's own repo and let the tool compound — user-triggered at first,
scheduled later once it's earned trust.

## User

One person (the repo owner) on one Mac (Apple Silicon or Intel, with a Claude
subscription logged in via a one-time `pi login`; oMLX optionally installed for local inference on
Apple Silicon). No accounts, no multi-tenancy, no network exposure beyond
`localhost`.

## Core flows

### 1. Ship a task
1. User registers a repo once (name + absolute path + default branch).
2. User creates a card: title, description/definition-of-done, target repo.
   Card lands in **Backlog**, where Auto Mode cannot schedule it.
3. User adds the card to the ordered **Todo** queue. With Auto Mode on by
   default, the task enters **In Progress** when its turn arrives. The user can
   also press **Start now** to claim it immediately. The pipeline then takes
   over, and the card stays in In Progress showing its live sub-state:
   - **Planning** — the frontier planner reads the repo and writes plan
     artifacts. Card shows the plan when done.
   - **Looping** — when a loop slot is free, the loop agent grinds in a
     worktree, iteration by iteration. Card shows iteration count, current
     transcript, files touched.
   - **Evaluating** — after the loop signals DONE, a separately configured
     evaluator acts as the sole whole-card verifier: it inspects the diff and
     runs the acceptance criteria. A revise verdict becomes the loop's next
     task; approve advances to human review.
4. The evaluator approves (or escalates after the bounded revision limit); the
   orchestrator moves the card to **In Review** with the evaluator's verdict and
   the diff. User reviews in-app:
   - **Approve** → Radulf merges the branch into the repo's default branch,
     cleans up the worktree, moves the card to **Done**; or
   - **Reject** → user writes feedback; feedback is appended to the plan and
     the card goes back to In Progress for another loop run.

### 2. Rescue a stuck task
A loop that hits its iteration cap or timeout, or errors repeatedly, moves the
card to **Needs Attention** with the exit reason, the transcript, and a
machine-written summary of where it got stuck. The user can edit the card/plan
and restart it, return it to Backlog, or abandon it.

### 3. Tell it to improve itself
The Radulf repo is registered like any other. The user writes improvement
cards against it — or starts an **Improvement Run**, which self-drives a
time-boxed batch of proposed, auto-approved changes onto one accumulating
feature branch for the user to review afterward. No cron, no background
autonomy in v1 — the run is user-triggered and user-timeboxed. Details in
[06-self-improvement.md](06-self-improvement.md).

## Workflow states

| State | Meaning | Moved by |
|--------|---------|----------|
| Backlog | Written, not scheduled; ignored by Auto Mode | User (create) |
| Todo | Ordered execution queue | User (queue/prioritize) |
| In Progress | Pipeline working: planning → waiting for slot → looping → evaluating (and revision cycles) | User starts; orchestrator within |
| In Review | Diff ready for human judgment | Orchestrator |
| Needs Attention ⚠ | Stuck: stalled, capped, errored, or merge-conflicted | Orchestrator |
| Done | Merged | Orchestrator (on Approve) |

The orchestrator moves cards as it works them. The human-gated transitions
are Backlog→Todo (schedule), Todo→In Progress (automatic with Auto Mode or
manual Start now), Needs Attention→In Progress (restart after fixing the
card/plan), and the review verdict (Approve → Done, Reject → In Progress).

The home UI presents these states as an attention-ordered Work feed rather
than horizontal columns: work needing review or intervention first, active
work second, the ordered Todo queue third, Backlog fourth, and recent
completions last. See
[10-mobile-first-ui.md](10-mobile-first-ui.md).

## Non-goals (v1)

- Multi-user, auth, or hosting anywhere but `localhost`.
- Remote runners or non-Mac platforms.
- Parallel loops or planners. The pipeline runs one ticket at a time; local
  models own the machine's unified memory, so the queue is always serial.
- GitHub integration (PRs, issues sync). The merge target is the local branch;
  pushing is the user's business.
- Non-coding tasks. The definition of done is always verifiable in a repo.
- Scheduled/background autonomy (crons). Everything is user-initiated in v1;
  scheduling is a natural later card for Radulf to build into itself.
- Autonomous merging. Never in any version without explicit user opt-in design.
