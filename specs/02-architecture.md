# 02 — Architecture

## Shape

One Next.js process serves the UI, the API, and hosts the orchestrator — a
long-lived in-process singleton that owns the job queue, drives agent runs as
in-process pi (SDK) sessions (spec 13; no subprocess), and writes state to
SQLite. Local-first, single-user, no external services at runtime except the
agent endpoints (Anthropic via the user's pi Claude subscription login by
default; optionally ChatGPT/Codex, OpenRouter, or a local oMLX server on
`localhost:8000`).

```
┌─────────────────────────────── Next.js (node, port 3000) ──────────────────────────────┐
│                                                                                         │
│  React UI (board, card detail, diff review)                                             │
│      │  fetch / SSE                                                                     │
│  Route handlers (/api/*)                                                                │
│      │                                                                                  │
│  Orchestrator (singleton, started from instrumentation.ts)                              │
│   ├─ state machine: card/run lifecycle                                                  │
│   ├─ serial loop queue (concurrency = 1)                                                │
│   └─ runners (in-process pi SDK sessions)                                               │
│        ├─ PlanRunner      → configured provider (pi SDK)                                 │
│        ├─ LoopRunner      → configured provider (pi SDK), repeated                       │
│        ├─ EvaluatorRunner → configured provider (pi SDK), mandatory after DONE,          │
│        │                    also writes the card summary + stale-doc updates (spec 14)   │
│        └─ PMRunner        → configured provider (pi SDK), user-triggered proposals       │
│                                                                                         │
│  Drizzle + better-sqlite3 ── data/radulf.db                                           │
└─────────────────────────────────────────────────────────────────────────────────────────┘
         │                                        │
   registered repos                        data/worktrees/<card>/   (git worktree per run)
   (user's checkouts, read-only            data/transcripts/<run>/  (normalized jsonl)
    except merge-on-approve)
```

## Stack

- **Next.js 15+ (App Router), TypeScript, React** — UI + API in one codebase,
  which matters because agents will modify this app; one coherent project is
  easier for a loop to reason about than a split frontend/backend.
- **SQLite via Drizzle ORM + better-sqlite3** — synchronous, zero-config,
  trivially inspectable. Schema in [03-data-model.md](03-data-model.md).
- **Tailwind CSS** for styling. State changes use explicit controls; optional
  desktop drag is limited to Todo queue ordering and must share the same
  accessible reorder mutation as touch/keyboard controls (10).
- **SSE** (route handler streaming) for live run output — no websocket server
  to manage. No cron/scheduling dependency in v1: all work is user-initiated.
- Diff rendering from `git diff` output parsed server-side (no heavyweight
  client diff lib; a small parser + custom component).

## The orchestrator

Started once per server boot via `instrumentation.ts` (guarded against dev
hot-reload double-start). Responsibilities:

1. **Recovery on boot** — any run marked `running` in the DB is stale (the
   process died); mark it `interrupted`, move its card to Needs Attention,
   leave the worktree for inspection.
2. **Queue pumping** — when the user starts a card it enters the work queue;
   whenever the pipeline slot frees up, the orchestrator advances one card:
   the oldest started ready card loops, or — if none is ready — the next Todo
   card is planned. A completed loop always enters evaluation before human
   review; a revise verdict returns it to the ready queue with an injected
   feedback task. Only one ticket occupies the pipeline at a time: nothing new
   starts while a card is planning, looping, or evaluating (`pump` returns early
   when `pipelineBusy()` is true, tracking the in-flight loop in an
   `activeLoopCards` set). There are no parallel loops or planners. Cards
   waiting for the slot show a "queued" sub-state in In Progress.
3. **Session management** — drive one in-process pi (SDK) session per run,
   normalize its event stream to a transcript file, and mirror run-level status
   to the DB. Abort on timeout/stall/cancel and always `dispose()`. The agent's
   `bash` tool runs with a scrubbed env (spec 13 Security) so it never inherits
   Radulf's own secrets.
4. **Events** — append-only `events` table (card moved, run started, iteration
   finished, merge done…) powering both the activity feed and SSE.

## Runner contracts

Runners are thin wrappers over **one in-process pi (SDK) session per run** —
no subprocess, no `RunnerAdapter` seam (retired by
[13-single-pi-sdk-harness.md](13-single-pi-sdk-harness.md)). Every role and
provider drives the same runner; providers differ only in how their pi `Model`
is resolved and authenticated. Common shape:

```ts
interface RunnerResult {
  exit: "completed" | "failed" | "timeout" | "cancelled";
  transcriptPath: string;
}
```

**PlanRunner** — cwd = a fresh worktree for the card; auth = the user's pi
Claude subscription login (held in the Radulf-owned pi agent dir); model = the
user-set `plannerModel` setting resolved through pi's `ModelRuntime` (opus /
sonnet / haiku or a full model id; blank = the subscription's default model).
Single invocation, structured output written to `.ralph/` in the worktree (see
[04-agent-pipeline.md](04-agent-pipeline.md)).

**LoopRunner** — cwd = same worktree; the pi session is configured from the
`loopProvider` setting (spec 13):

- `anthropic` (default) / `chatgpt`: the pi Claude Pro/Max or ChatGPT (Codex)
  subscription login, held in the Radulf-owned pi agent dir.
- `omlx` / `openrouter`: a custom-provider block / runtime API key on the shared
  `ModelRuntime`. Provider credentials (oMLX base URL/key, OpenRouter key) live
  in Radulf settings and flow into the session, never onto disk in the worktree.

Each loop iteration is one fresh-context pi session prompted with
`.ralph/PROMPT.md` under the structural skip-permissions posture — the classic
Ralph posture. Loop mechanics are specced in 04; the SDK runner, event
normalization, and in-process env isolation in 13.

**EvaluatorRunner** — cwd = the completed loop's existing worktree. It uses the
independently configured `evaluatorProvider`/`evaluatorModel`, reads the card,
`.ralph/CRITERIA.md`, `.ralph/DONE`, and source diff. It is the sole authoritative
whole-card verifier and runs every named check. Its only allowed artifact is
`.ralph/EVALUATION.md`; the orchestrator rejects the verdict if source files or
Git history change. `VERDICT: approve` advances to human review, while
`VERDICT: revise` creates plan v(n+1), appends a private checklist task, and
requeues the loop. See 04 for the bounded revision cycle.

## Filesystem layout (runtime data)

```
data/
  radulf.db
  worktrees/<cardSlug>-<runId>/     # git worktree, branch ralph/<cardSlug>-<runId>
  transcripts/<runId>/
    plan.jsonl
    iter-001.jsonl … iter-NNN.jsonl
```

`data/` is gitignored. Worktrees are created with
`git -C <repo> worktree add <path> -b <branch> <defaultBranch>` and removed
(`worktree remove --force` + `branch -D` when rejected/abandoned) by the
orchestrator only — never by the agent.

## Safety posture

- Loop agents run under a structural skip-permissions posture — pi (SDK) has no
  permission system, so the classic Ralph loop's "no permission prompts, no
  deny-list" is inherent, not a flag. Containment comes from
  structure, not the permission system: the loop's cwd is a disposable
  worktree, `PROMPT.md` guardrails say never push / stay in the worktree, and
  nothing reaches the user's checkout except the orchestrator's merge step.
- **Amended by [14-sandboxing.md](14-sandboxing.md):** "structure" now means
  kernel-enforced containment, not just cwd + prompt text. Every bash-holding
  role's agent bash runs inside an OS sandbox (Seatbelt/bubblewrap+seccomp)
  with a filesystem allow/deny policy, default-deny network egress, and
  Unix-socket denial; the in-process file tools (read/write/edit/grep/find/ls)
  are guarded to the same per-role roots. The worktree-cwd and `PROMPT.md`
  guardrails described above remain in place as defense-in-depth, but they
  are no longer the boundary itself.
- The user's registered checkout is only written by the orchestrator's merge
  step (`--no-ff` merge of the ralph branch), and only on explicit Approve —
  unsandboxed, trusted server code, re-verified by a repo-integrity check
  immediately before the merge (spec 14).
- Hard caps per loop run: max iterations (default 50) and wall-clock timeout
  (default 60 min), both per-card overridable.

## Configuration

Settings table (editable in UI, seeded with defaults): provider + model per
role (planner / loop / evaluator, all defaulting to `anthropic` — no
summarizer role, spec 14), optional
provider credentials (oMLX base URL + API key, OpenRouter API key), max
iterations, loop timeout, and optional browser notification/sound toggles
(alert when a card reaches In Review or Needs Attention). Secrets stay in
SQLite — acceptable for a single-user local app.
