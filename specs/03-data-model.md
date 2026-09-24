# 03 — Data Model

SQLite, Drizzle ORM, better-sqlite3. Timestamps are ISO-8601 UTC strings.
IDs are `nanoid` strings unless noted. All FKs `ON DELETE CASCADE` unless noted.

## Tables

### repos
| column | type | notes |
|--------|------|-------|
| id | text PK | |
| name | text | display name, unique |
| path | text | absolute path to the user's checkout, unique |
| defaultBranch | text | merge target, e.g. `main` |
| approvedInstallScripts | text | JSON array of `{name, version, scriptHash}`, default `[]` — packages whose lifecycle scripts a human approved via the install-script gate (spec 14); a version or script-body change re-triggers the gate |
| createdAt | text | |

### cards
| column | type | notes |
|--------|------|-------|
| id | text PK | |
| repoId | text FK → repos | |
| title | text | |
| description | text | markdown; must contain a definition of done |
| status | text | `backlog · todo · planning · ready · plan_review · looping · evaluating · paused · review · reviewing · needs_attention · done · abandoned` (default `backlog`) — `backlog` is never auto-scheduled; `todo` is the execution queue; `evaluating` is the mandatory agent gate between loop DONE and human review; `paused` is set after a user-initiated loop pause; `reviewing` is the atomic human-decision claim |
| position | real | ordering within a column (fractional insert) |
| source | text | `user` \| `agent` (Improvement Run proposals) |
| reviewPlanBeforeImplementation | integer (boolean) | non-null, default 0 (false); when true, the plan pauses at `plan_review` for user approval before the loop phase begins |
| maxIterations | integer nullable | overrides setting default |
| timeoutMinutes | integer nullable | overrides setting default |
| plannerModel | text nullable | per-card planner model override |
| loopModel | text nullable | per-card loop model override |
| evaluatorModel | text nullable | per-card evaluator model override |
| planCritic | integer nullable | spec 30: per-card plan critic override — null follows the `planCriticMode` setting, 1 on, 0 off |
| criticModel | text nullable | spec 30: per-card plan critic model override |
| startedAt | text nullable | set on Todo→In Progress; work-queue order (FIFO) |
| createdAt / updatedAt | text | |

Status → board section mapping: `backlog` → Backlog; `todo` → Todo;
`planning`/`plan_review`/`ready`/`looping`/`evaluating`/`paused` →
In Progress (rendered as sub-state badges: planning ◔, plan-ready-for-review ✓,
queued-for-slot, iter n/max, evaluating 🔎, paused ⏸); `review` → In Review; `needs_attention` → Needs Attention (the
card shows the latest run's `exitReason`); `done` → Done. `ready` = planned,
waiting for the single pipeline slot to free. `paused` = a `looping`
task the user asked to pause: the current iteration finishes, the run ends
(`status = completed`, `exitReason = "paused by user"`), and the card waits in
`paused` until resumed (`paused → ready` via `POST /api/cards/[id]/resume`, which
reuses the existing worktree and checked `PLAN.md`). `abandoned` cards are hidden (listed in
card history).

### plans
One row per planning attempt; the latest `approved`/`active` plan drives loops.
| column | type | notes |
|--------|------|-------|
| id | text PK | |
| cardId | text FK → cards | |
| version | integer | 1..n per card |
| planMd | text | PLAN.md content (approach, steps, risks) |
| promptMd | text | PROMPT.md content — the exact Ralph loop prompt |
| acceptanceCriteria | text | verifiable checklist extracted by the planner |
| feedback | text nullable | reviewer feedback that triggered this version |
| createdAt | text | |

### runs
| column | type | notes |
|--------|------|-------|
| id | text PK | |
| cardId | text FK → cards | |
| planId | text FK → plans, nullable | null for planning runs |
| kind | text | `plan` \| `critique` \| `loop` \| `evaluate` — no separate `summarize` kind; the evaluator writes the summary (spec 14); `critique` is the spec 30 plan critic |
| status | text | `running · completed · failed · timeout · cancelled · interrupted · paused` — `paused` is used transiently by the orchestrator to mark a loop run that ended because the user paused the task |
| worktreePath | text | |
| branch | text | `ralph/<cardSlug>-<runId>` |
| iterationsDone | integer | 0 for plan runs |
| exitReason | text nullable | human-readable: `done-signal`, `max-iterations`, error summary… |
| sandboxed | integer nullable | spec 14: `1` = this run's agent bash was sandbox-wrapped; `0` = `sandboxEnabled` was off; `null` = pre-sandbox run |
| diskLimitMechanism | text nullable | spec 14: `watchdog` \| `apfs-quota` \| `sparse-image` \| `cgroup` — the real disk bound in force for this run |
| startedAt / endedAt | text | |

### iterations
| column | type | notes |
|--------|------|-------|
| id | integer PK autoincrement | |
| runId | text FK → runs | |
| n | integer | 1-based |
| status | text | `running · completed · failed` |
| transcriptPath | text | `data/transcripts/<runId>/iter-NNN.jsonl` |
| summary | text nullable | last assistant text of the iteration |
| startedAt / endedAt | text | |

### reviews
| column | type | notes |
|--------|------|-------|
| id | text PK | |
| runId | text FK → runs | |
| decision | text | `approved` \| `rejected` |
| feedback | text nullable | required when rejected |
| mergeCommit | text nullable | sha recorded on approve |
| createdAt | text | |

### improvement_runs
One row per Improvement Run (§06). `(repoId, status)` is indexed to enforce
one active run per repo.
| column | type | notes |
|--------|------|-------|
| id | text PK | |
| repoId | text FK → repos (cascade) | |
| status | text | `running · completed · stopped · failed` (default `running`) |
| featureBranch | text | `ralph/improve-<ts>`, cut off `baseBranch` once at creation; every spawned card uses it as its own `baseBranch` |
| baseBranch | text | branch the feature branch was cut from |
| focusPrompt | text nullable | empty → default self-improvement prompt |
| plannerModel / loopModel / evaluatorModel | text nullable | per-run overrides |
| plannerReasoning / loopReasoning / evaluatorReasoning | text nullable | per-run overrides (`loopReasoning`/`evaluatorReasoning` are stored but not yet applied — no matching per-card column exists) |
| maxIterations / timeoutMinutes | integer nullable | per-task caps; timeout is additionally capped at the run's remaining budget |
| deadlineAt | text | ISO; run-level budget end, checked only between tasks |
| currentCardId | text nullable | in-flight card, persisted so a server restart can re-attach |
| tasksCreated / tasksSucceeded / consecutiveFailures | integer | counters; the run stops after 3 consecutive failures |
| createdAt / updatedAt / endedAt | text | |

### events
Append-only activity log; powers the feed and SSE change notifications.
| column | type | notes |
|--------|------|-------|
| id | integer PK autoincrement | |
| cardId | text nullable | |
| runId | text nullable | |
| type | text | `card.created · card.moved · run.started · iteration.completed · run.finished · review.decided · improvement.started · improvement.completed …` |
| payload | text | JSON |
| createdAt | text | |

### settings
| column | type | notes |
|--------|------|-------|
| key | text PK | |
| value | text | JSON-encoded |

Seeded keys (see `SETTING_DEFAULTS` in `src/server/settings.ts`):
`plannerProvider` / `plannerModel`, `loopProvider` / `loopModel`,
`evaluatorProvider` / `evaluatorModel` (providers default to `anthropic`,
models to blank = subscription default; no summarizer keys — the role was
dropped, spec 14),
`plannerReasoningLevel` / `loopReasoningLevel` / `evaluatorReasoningLevel`
(per-agent pi thinking level, default `medium`;
universal across providers since spec 13),
`criticProvider` / `criticModel` / `criticReasoningLevel` /
`criticTimeoutMinutes` / `criticPromptTemplate` and `planCriticMode`
(`breakdown` default, `always`, `off`) for the spec 30 plan critic,
`sandboxEnabled` (bool, default `true` — spec 14's one sandbox escape
hatch; not model-reachable), `sandboxNetworkAllowlist` (text, one domain per
line, default `""` — extra L1 egress allowlist entries beyond package
registries),
`omlxBaseUrl`, `omlxApiKey`, `openrouterApiKey` (optional provider
credentials), `defaultMaxIterations`, `defaultTimeoutMinutes`, `autoMode`
(default true; schedules only `todo`),
`notificationsEnabled`, `soundEnabled` (optional browser notification and
alert-sound toggles, both default false), `theme` (UI theme name, default
`"default"`; one of default, default-light, solarized-dark,
solarized-light, tokyo-night, tokyo-day, nord, nord-light, gruvbox-dark,
gruvbox-light), and `plannerPromptTemplate`, `evaluatorPromptTemplate`,
`summarizerPromptTemplate`, `improvePromptTemplate` (editable agent prompts whose
built-in defaults remain versioned under `src/prompts/`). Built-in prompt text
is not persisted until customized, so application updates can improve defaults.

## Lifecycle invariants

- At most one card has `status = looping` at any time (enforced by the
  orchestrator, asserted on boot recovery).
- A loop's DONE signal finishes its loop run and moves the card
  `looping → evaluating`; it never moves directly to `review`.
- A card in `review` has a latest completed loop plus a completed evaluator run
  whose verdict is `approve`, or a `revise` verdict escalated after the bounded
  evaluator revision limit. Historical pre-evaluator cards may have no
  evaluator run.
- Evaluator `revise` creates plan v(n+1), stores the feedback, appends an
  unchecked task to the orchestrator-private PLAN.md, and moves
  `evaluating → ready`. Missing/malformed output, source mutation, timeout, or
  provider failure moves `evaluating → needs_attention` and cannot be retried as
  a merge.
- Rejection creates a new `plans` row (version+1, feedback filled, promptMd
  amended) and returns the card to `ready` (In Progress); the old
  worktree/branch is kept and reused so completed work isn't lost.
- Approval merges `branch` into `repos.defaultBranch`, records `mergeCommit`,
  removes the worktree, deletes the ralph branch, card → `done`.
- `abandoned` (user action from Needs Attention or In Review) removes the
  worktree and branch after confirmation.
- **Pause** (`POST /api/cards/[id]/pause`, only from `looping`): the orchestrator
  sets a request flag that `runLoop` polls after each iteration; once seen, the
  in-flight iteration completes, the run finishes (`status = completed`,
  `exitReason = "paused by user"`), and the card moves `looping → paused`. The
  worktree, branch, and checked `PLAN.md` are preserved.
- **Resume** (`POST /api/cards/[id]/resume`, only from `paused`): the orchestrator
  clears the pause flag, moves the card `paused → ready`, and calls `pump()`,
  which reuses the existing worktree and the already-checked `PLAN.md` (it is
  **not** overwritten) so checklist progress survives the pause. The loop model
  and evaluator/summarizer model overrides can be edited via PATCH while the card is
  `paused`, so resumed iterations may run with different models.
- `backlog` and `paused` are never selected by `pump()` (which selects
  `ready` loops and, through the planning pump, only `todo` cards); a `paused`
  card's run is already finished,
  so `recover()` leaves it untouched on server restart — paused tasks survive
  restarts naturally.
- Moving a `paused` card back to `backlog` cancels the pause (the pause flag is
  cleared) without allowing Auto Mode to restart it.
- `reset` (user action from Needs Attention or In Review) wipes all progress
  after confirmation: aborts any live run, removes every worktree + branch for
  the card, deletes its `runs` rows (cascading `iterations` + `reviews`) and
  `plans`, clears `summary`/`startedAt`, and returns the card to `backlog` so it
  cannot run again until deliberately queued.
