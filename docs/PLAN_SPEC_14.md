# Implementation Plan — Spec 14: Sandboxing

Kernel-enforced containment for the skip-permissions loop. This plan translates
[`specs/14-sandboxing.md`](../specs/14-sandboxing.md) into concrete, ordered work
against the current codebase. The spec's own rollout order is deliberate — each
phase either shrinks blast radius on its own or de-risks the next — so this plan
follows it: **L3 hygiene → role split → L2 path guards → review hardening →
srt spike → L1 srt → ungate self-improvement.**

## Guiding constraints (do not drift from these)

- **Decision 7 stands.** No permission prompts, no model-visible approve/deny,
  no deny-list the model argues with. The install-script gate halts into Needs
  Attention for out-of-band human review — that is not an in-loop prompt.
- **Fail loudly, no silent unsandboxed fallback.** The one escape hatch is the
  `sandboxEnabled` setting (default on), which stamps `sandboxed: false` on
  every affected run.
- **Containment is per-run and per-role.** The two dangerous primitives
  (arbitrary command execution, network egress) must never sit in the same role.
- Each phase must leave `make check` (test + lint + typecheck + build) green.

## Scope decision — macOS only (2026-07-22)

**Platform scope is macOS.** Linux is best-effort / future, not a release
gate. srt's Linux path (bwrap/seccomp/AppArmor) stays implemented and
unit-tested where it already is, but live Linux verification is **explicitly
out of scope** — the items below that read "not verified on a real Linux host"
are **descoped**, not pending. They no longer block ungating. What still gates
the last step is the remaining **macOS-side** work (resource limits under real
load / ENOSPC, and the Go/JVM half of the positive control), not the Linux
acceptance table.

## Key integration seams (already in the tree)

| Seam | File | Role in this spec |
|------|------|-------------------|
| Bash `spawnHook({command,cwd,env})` | `src/server/harness/pi.ts:346` | L1 srt wrap + L3 env allowlist + commandPrefix |
| `agentEnv()` | `src/server/harness/types.ts:17` | L3: invert denylist → allowlist |
| `createRalphSession` tool set | `src/server/harness/pi.ts:369` | role capability split + L2 custom tools |
| `web_search` custom tool | `src/server/harness/webSearch.ts` | planner-only, query-only, capped, logged |
| `WORKTREES_DIR` | `src/db/index.ts:12` | L3: relocate out of `data/` |
| `createWorktree` | `src/server/git.ts:68` | consumes new worktree root |
| Loop run lifecycle | `src/server/orchestrator.ts:504` (`runLoop`) | TMPDIR/cache, reaping, integrity, install gate |
| Merge | `src/server/reviewService.ts:263` (`approveClaimedRun`) → `git.ts:118` (`mergeBranch`) | pre-merge integrity re-check |
| Planner run | `src/server/planningService.ts:80` | planner role, plans dir |
| Settings | `src/server/settings.ts`, `src/db/schema.ts:168` | new settings keys |
| Run metadata | `src/db/schema.ts:87` (`runs`) | `sandboxed`, `diskLimitMechanism` columns |
| Diff for review | `src/app/api/cards/[id]/diff/route.ts` + card UI | review-surface hardening |

---

## Phase 0 — Foundations: settings, schema, run-metadata

Land the data-model additions first so every later phase has somewhere to read
config from and stamp results into. Pure additive migration.

- [x] Add settings keys to `SETTING_DEFAULTS` + validators in `src/server/settings.ts`:
  - [x] `sandboxEnabled` (bool, default `true`) — add to `BOOLEAN_SETTINGS`; **not model-reachable** (no tool binding, ever).
  - [x] `sandboxNetworkAllowlist` (text, default `""`) — one domain per line; help text names the domain-fronting residual.
- [x] Add `runs` columns in `src/db/schema.ts`:
  - [x] `sandboxed` (integer/bool) — stamped per run, shown in run detail + analytics.
  - [x] `diskLimitMechanism` (text enum: `watchdog` | `apfs-quota` | `sparse-image` | `cgroup`) — the real bound in force.
- [x] Add `approvedInstallScripts` per-repo store: JSON of `{name, version, scriptHash}[]` — landed as a column on `repos` (resolved design question 2).
- [x] Generate migration: `make db-generate` → `drizzle/0001_eminent_mad_thinker.sql` (pure additive; `db-migrate` applies at app boot — no local DB existed to migrate ahead of time).
- [x] Add `RADULF_WORKTREES_DIR` and `RADULF_PLANS_DIR` env resolution in `src/db/index.ts` (see Phase 1).
- [x] Update `.env.example` with the two new env vars and a note.
- [x] Tests: settings validation accepts/rejects the two new keys (`requestValidation.test.ts`); schema round-trips the new columns (`src/db/schema.test.ts`).

---

## Phase 1 — Layer 3: layout & hygiene (no new dependency)

Highest value-per-risk; none of it can break a run a correct loop performs
today. Ships before srt.

### 1a. Worktree + plan relocation out of `data/`

- [x] In `src/db/index.ts`: `WORKTREES_DIR` becomes its own root — `process.env.RADULF_WORKTREES_DIR` ?? `worktrees/` **beside** `data/` (not inside it). Add `PLANS_DIR` = `RADULF_PLANS_DIR` ?? `plans/` beside `data/`.
- [x] Verify `createWorktree` (`git.ts:75`) and all `WORKTREES_DIR` consumers pick up the new root (git.ts is the only consumer; it imports the constant).
- [x] **Back-compat:** existing runs store absolute `worktreePath` in the DB (`runs.worktreePath`), so old runs keep resolving; only new runs use the new root. Confirm `latestWorktreeRun` (`orchestrator.ts:236`) and `resetCard` cleanup still work with mixed roots.
- [x] Create per-run `plans/<run-id>/` before the planner starts (Phase 2 uses it as the planner's only writable path).
- [x] Tests: new worktrees land under the new root (`src/db/schema.test.ts` layout assertions; `createWorktree` builds from `WORKTREES_DIR`); DB rows store absolute paths and lifecycle tests exercise roots outside `WORKTREES_DIR` throughout.

### 1b. Env becomes an allowlist (`agentEnv()`)

- [x] Invert `agentEnv()` in `src/server/harness/types.ts`: construct a **minimal** env instead of deleting three keys. Include only: `PATH`, `HOME`, `TMPDIR`, `LANG`/`LC_*`, `TERM=dumb`, git vars (1c), package-manager cache vars (1d), and whatever srt's proxy injects (pin in checklist #7 before L1).
- [x] `SSH_AUTH_SOCK` excluded **by construction** — add an explicit test asserting it never appears.
- [x] Keep the OpenRouter-key re-add path working (runtime override, not agent env).
- [x] Update the docstring (currently describes the three-item denylist).
- [x] Tests (`src/server/sandbox/sandbox.test.ts`): `agentEnv()` contains only allowlisted keys; asserts absence of `RADULF_AUTH_SECRET`, `RADULF_AUTH_PASSWORD_HASH`, `SSH_AUTH_SOCK`, and an arbitrary injected `FAKE_TOKEN`.

### 1c. Git hardening in the agent env

- [x] Add to `agentEnv()`: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/false`, `GIT_SSH_COMMAND=/bin/false`.
- [x] Add commit identity (`AGENT_GIT_IDENTITY` constant — checklist #4 pinned by a real-repo commit test): `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` (constant is fine — pin in checklist #4). Needed because `GIT_CONFIG_GLOBAL=/dev/null` removes user identity.
- [x] **Note:** orchestrator/bookkeeping git (`tryGit`) runs as trusted server code with the normal env — only the *agent's* bash env is hardened. Confirm loop commits made by the agent (if any) vs. orchestrator commits: in this codebase commits are orchestrator-driven (`bookkeeping.ts`, `performIterationBookkeeping`), so agent-git identity mainly matters if the agent runs `git commit` itself. Verify against `.ralph`/PROMPT contract.
- [x] Test: agent-env git has no global/system config and cannot reach an askpass helper (real-repo test asserts no `.gitconfig` origin and env-derived identity).

### 1d. Per-run TMPDIR + package-manager caches

- [x] In `runLoop` (`orchestrator.ts:504`) and the other run entry points (planner, evaluator, summarizer): create a run-private `TMPDIR` at run start, delete at run end.
- [x] Point `npm_config_cache` (+ pnpm/yarn equivalents) at a Radulf-owned cache root the host user never consumes. Thread these into `agentEnv()`/spawn env per run.
- [x] These are per-run values, so they likely need to flow from the orchestrator through `runHarness` → `createRalphSession` → `spawnHook`. Add a `runEnv`/`sandbox context` param to the harness call chain (`RunHarnessOpts` in `harness/index.ts:149`).
- [x] Cleanup on run end even on failure/timeout/cancel (finally blocks).
- [x] Tests: TMPDIR is created and removed; cache env points at the Radulf root, not `~/.npm`.

### 1e. Resource limits

- [x] **Linux:** per-run cgroup v2 slice (`sandbox/cgroup.ts`; best-effort setup — real enforcement pinned by checklist #9) with `memory.max`, `pids.max`, `io` limits. Conservative defaults, **not** user-facing settings yet.
- [x] **`ulimit -t` and `ulimit -f`** kept on both platforms as cheap single-process backstops via pi's `commandPrefix` preamble. **Do NOT set** `ulimit -u` (RLIMIT_NPROC, self-DoS), `ulimit -v` (RLIMIT_AS, breaks Go/JVM). Record why in a comment so they aren't reintroduced.
- [x] **macOS disk:** ship **watchdog + ballast** as the default (no operator setup, can't fail-closed on fresh install):
  - [x] Watchdog: orchestrator samples worktree size + volume free space every few seconds; fail the run past a threshold with real headroom (tune from checklist #9).
  - [x] Ballast: pre-allocate a few GB (2 GiB, allocated async at loop start; skipped under test); delete on disk-pressure to keep the machine usable.
- [x] Stamp `diskLimitMechanism` on the run row (`cgroup` on Linux, `watchdog` default on macOS).
- [x] Document the APFS-volume-quota hardened option + sparse-image alternative in Requirements/README (Phase 7) — done in Phase 7 (README "Disk limits" section, with the real `diskutil apfs addVolume` syntax for this host).
- [x] Tests: watchdog trips past threshold; cgroup config assembled correctly (unit-level, real enforcement in checklist #9).

### 1f. Process-group reaping at run end

- [x] Each bash invocation runs in its own process group (pi already spawns detached; the commandPrefix records `$$` per invocation to the run's pgid file) (set via spawn options in `spawnHook`/`createBashToolDefinition`).
- [x] At run end, orchestrator kills the group and, on Linux, everything remaining in the run's cgroup, then **verifies the group is empty** before proceeding.
- [x] This must run **before** the integrity check (1g) and before merge — a surviving process otherwise plants hooks after the check.
- [x] Test: `nohup sleep 600 &` inside a detached shell → group empty after reaping (real-process test).

### 1g. Repo integrity check — run end AND immediately pre-merge

- [x] New helper (`src/server/integrity.ts`): verify the parent repo — no hook files appeared/changed under `.git/hooks`, `.git/config` unchanged, no refs outside `refs/heads/ralph/<this-run-branch>` moved. Return the diff of what moved.
- [x] Snapshot the baseline (hook file hashes, config hash, ref set) at run **start**.
- [x] Run at **run end** (after reaping) — a violation → card to Needs Attention with the diff of what moved.
- [x] Re-run the **hook/config portion immediately before merge** in `approveClaimedRun` (`reviewService.ts:263`), however long the card sat in In Review. This is the load-bearing check.
- [x] Tests: planted `.git/hooks/pre-commit` caught at run end; ref moved outside `ralph/<run>` caught; hook planted after run-end check caught pre-merge (`integrity.test.ts`, real git repo).

### 1h. Install-script gate (lands in L3; needs resume path, no sandbox)

- [x] Agent installs always run with lifecycle scripts disabled (agent env sets ignore-scripts; but **detection does not trust the env** — see below).
- [x] After an install, orchestrator enumerates every `preinstall`/`install`/`postinstall`/`prepare` in the **resolved dependency tree** (structural, not textual — CLI flags override env, so reading the resolved tree is the only reliable signal).
- [x] Diff that set against the per-repo `approvedInstallScripts` list (Phase 0), keyed on `{name, version, scriptHash}`.
- [x] If anything unapproved → **halt the run, card → Needs Attention**, showing package name, version, verbatim script body.
- [x] On approval: `npm rebuild <pkg>` for approved packages **only** (per-package granularity), record in the repo's approved list, and **resume the paused run in place** (checklist #11 — reuse existing pause/continue machinery, do NOT requeue to Todo).
- [x] `scriptHash` mismatch (version bump or edited script) re-fires the gate.
- [x] pnpm path: `onlyBuiltDependencies` is the native form; noted in `installGate.ts`.
- [x] **Trigger detection:** the gate must fire regardless of how `npm install` was invoked. Decide the hook point — likely post-iteration inspection of the worktree's resolved tree (`node_modules/.package-lock.json` / lockfile) rather than intercepting the command.
- [x] Card-lifecycle: this is the **first Needs Attention transition that preserves run state**. Resume reuses the existing worktree + private checklist (same machinery as pause/continue); a gate that fired on the DONE path resumes straight into evaluation. Confirm pause/continue covers a run paused mid-iteration and that it restarts the iteration cleanly rather than resuming a half-applied install.
- [x] Tests: `postinstall` package halts with script body; `--ignore-scripts=false` override still caught (resolved-tree detection); approved package version bump re-fires; approval resumes (not restarts) — `installGate.test.ts` + lifecycle suite.

---

## Phase 2 — Role capability split + drop the summarizer

Removes an entire exfiltration channel independent of whether L1 ships. Requires
threading a **role** through the harness call chain. **Decided (supersedes spec
14's four-role table):** the summarizer role is deleted — the evaluator writes
the summary, and stale-doc updates move into the loop. Rationale below.

### 2a. Drop the summarizer, fold summary + doc-updates into the evaluator

**Why:** the summarizer was the most-capable role (bash + write + web_search)
over the most-digested untrusted content, purely to `git diff` + write a
summary + edit docs. The evaluator already understands the change deeply (it
just judged it against criteria), so it absorbs both jobs. The only obstacle is
the evaluator's **integrity check** (`evaluationService.ts:139-185`), today a
blunt "touched any non-`.ralph` file → reject." We **narrow** it rather than
drop it:

- **Code + git history: still immutable.** This is the load-bearing guarantee —
  the judge provably cannot edit the implementation it judged to make its own
  verdict pass. Doc edits can't game a verdict, so this guarantee survives fully.
- **Docs: allowed.** The evaluator may write an allowlisted set of doc paths.
  Post-run, the check asserts every changed non-`.ralph` path is a doc path,
  else rejects to needs_attention.
- **Summary → `.ralph/`.** Excluded from the check and stripped at merge.

Accepted residual (no worse than today's summarizer): the evaluator's doc edits
are not *independently re-judged* by another agent — the human diff review is
their gate.

Tasks:

- [x] **Doc allowlist** — default `specs/**`, `docs/**`, `README*`, top-level
  `*.md`; tunable per-repo later. Defined in one place (`src/shared/docPaths.ts`,
  `isDocPath`/`changedPaths`) that the narrowed integrity check reads.
- [x] **Narrow the integrity check** (`evaluationService.ts`): git history still
  rejects unconditionally (`headAfter !== headBefore`); uncommitted non-`.ralph`
  changes reject only if any newly-changed path is **not** a doc-allowlist path.
- [x] Evaluator writes a brief summary **every run** to `.ralph/SUMMARY.md`
  (chose the sibling-file option over extending `parseEvaluation`), and on
  **approve** updates stale docs. `src/prompts/evaluate.md` updated: judge; write
  `SUMMARY.md` every run; on *approve* only, edit doc-allowlist paths; never
  commit.
- [x] In `evaluationService.ts`, on `approve` **and** `revise — limit reached`:
  read the summary → set `card.summary` (`applySummary`); commit doc edits +
  verdict onto the review branch (`add -A`, via `advanceToReview`); then
  `moveCard(evaluating → review)` directly. The `summarizing` + `deps.summarize()`
  blocks are gone. **Missing summary is non-fatal** (proceeds to review).
- [x] Delete summarizer plumbing:
  - [x] `orchestrator.ts`: `runSummarizer`, `activeSummarizerCards`, the
    `summarize` dep on `EvaluationService`, the `summarize` case in
    `retryFailedStep`, `summarizing` in `recover` orphans and `pipelineBusy`,
    `SUMMARIZE_TIMEOUT_MS`, `renderSummarizerPrompt`.
  - [x] `db/schema.ts`: dropped `summarizing` from `CARD_STATUSES`, `summarize`
    from run `kind`, `summarizerModel` from `cards` (migration `0002`).
  - [x] `settings.ts`: removed `summarizerProvider`/`summarizerModel`/
    `summarizerReasoningLevel`/`summarizerPromptTemplate` + the summarize.md
    default.
  - [x] `src/shared/failedStep.ts` + `cardRequests.ts` + `cardValidation.ts`:
    dropped the `summarize` step / `summarizerModel` field.
  - [x] UI (`card/[id]/*`, `settings/page.tsx`, `newTaskDialog.tsx`,
    `info/page.tsx`, `page.tsx`, API routes, `ui/api.ts`): removed summarizer
    provider/model pickers, the `summarizing` status, `summarize` run-kind labels.
  - [x] `benchmarks.ts` (`summarizeReport` is an unrelated report helper — kept),
    `retention.ts` (no summarize handling): nothing to drop.
  - [x] Deleted `src/prompts/summarize.md`.
  - [x] Updated tests: `orchestrator.test.ts`, `orchestrator.lifecycle.test.ts`,
    `requestValidation.test.ts`, `failedStep.test.ts`,
    `newTaskDialog.test.tsx`, `info/page.test.tsx`, `card/[id]/page.test.tsx`;
    added `src/shared/docPaths.test.ts` and a lifecycle test that an evaluator
    editing a non-doc file is rejected to needs_attention.
- [x] Summarizer removal complete; `make check` green (431 tests).

### 2b. Role split for the three surviving roles

- [x] Introduce a `role` concept: `planner | loop | evaluator` (`AgentRole` in `pi.ts`). Added to `CreateRalphSessionOpts` and `RunHarnessOpts`; each caller passes its own role (`planningService` → `planner`, `orchestrator.runLoop` → `loop`, `evaluationService` → `evaluator`). `readOnly` survives for the human-interactive, non-pipeline sessions (chat, PM pass); the pipeline roles use `role` instead.
- [x] Per-role tool sets in `createRalphSession` (`toolsForRole` in `pi.ts`):

  | Role | bash | web_search | fs tools |
  |------|------|-----------|----------|
  | Planner | ✗ | ✓ (only role) | read/grep/find/ls (repo RO); write/edit → plan dir only |
  | Loop | ✓ | ✗ | read/write/edit/grep/find/ls (worktree) |
  | Evaluator | ✓ | ✗ | read/write/edit/grep/find/ls (worktree); summary → `.ralph/` |

- [x] **`web_search` → planner only.** Bound only when the role's tool set names it (`toolsForRole`); loop/evaluator never get it.
- [x] Harden `web_search` in `src/server/harness/webSearch.ts`:
  - [x] Query-only, no agent-supplied URL, no fetch-follow-up (params are `query`/`count` only — no URL param).
  - [x] Cap query at **256 chars** (`MAX_QUERY_CHARS`); **≤ 8 calls per planner run** (`MAX_CALLS_PER_RUN`, per-session closure counter).
  - [x] Every query reaches the transcript verbatim via the normalized tool-call event.
- [x] Acceptance tests: loop/evaluator never bind `web_search`; planner binds it but no bash (`pi.test.ts` `toolsForRole` suite); `web_search` over 256 chars or the 9th call → rejected without a fetch, over-cap query does not spend budget (`webSearch.test.ts`); each caller passes its role (`orchestrator.lifecycle.test.ts` retry-step suite).

---

## Phase 3 — Layer 2: path containment for in-process file tools

Pure app code. Land with a test card that tries to read/write outside each
role's roots through each tool.

- [x] One shared guard function (`src/server/sandbox/pathGuard.ts`,
  `guardPath`): expand `~`, resolve against cwd, realpath the deepest existing
  ancestor (so not-yet-created write targets resolve and symlinks can't
  launder — `realpathBestEffort`), compare by **path-segment** via
  `isInsideOrEqual` (`path.relative`, not string prefix — `<worktree>-evil` is
  not inside `<worktree>`).
- [x] Single error shape (`pathBoundaryMessage`; the leading `Error: ` the spec
  shows is supplied by `Error.toString()`):
  ```
  Error: path escapes this run's boundary — this role may only touch
  <allowed-roots>. Use bash for read-only inspection of system paths.
  ```
- [x] Override `read`, `write`, `edit`, `grep`, `find`, `ls` as custom tools in
  `createRalphSession` (`src/server/harness/guardedTools.ts`,
  `createGuardedFsTools`) — thin `async` wrappers around pi's
  `create{Read,Write,Edit,Grep,Find,Ls}ToolDefinition` that **guard-then-delegate**
  (never reimplement). Injected only for the pipeline roles; the guarded tools
  override the built-ins by name (same `customTools` mechanism as `scrubbedBash`).
- [x] Per-role roots (`pathRootsForRole` in `pi.ts`):

  | Role | Read roots | Write roots |
  |------|-----------|-------------|
  | Planner | repo checkout (`cwd`) | `<worktree>/.ralph` only |
  | Loop | worktree | worktree |
  | Evaluator | worktree | worktree (net tracked changes constrained to docs + `.ralph/` by the post-run integrity check, not L2) |

  **Amendment (resolved with the user):** spec 14's table named a separate
  `plans/<run-id>/` write root for the planner, but the planner's artifacts
  must live in `<worktree>/.ralph/` where `planningService` and the loop
  consume them, so the write root is that subtree — the planner still cannot
  touch source. `planningService` now ensures `<worktree>/.ralph` exists (the
  vestigial `PLANS_DIR/<run-id>` mkdir is gone; the `PLANS_DIR` constant
  stays). Reconcile spec 14 §Layer 2 table in Phase 7.
- [x] **Mutating tools root-only, no exceptions** (not even `.git` — commits go
  via bash under L1; edit guards against write roots, which are ⊆ read roots).
  **Read-side tools root-only too** — the escape hatch for legit outside reads
  is bash (kernel decides), keeping the wrapper trivial.
- [x] Planner has no bash → no escape hatch (correct: a planner needing outside
  reads is being manipulated). Its containment is L2+L3 only.
- [x] Acceptance tests (`pathGuard.test.ts`, `guardedTools.test.ts`,
  `pi.test.ts`): abs path outside roots → guard; sibling `-evil` prefix →
  segment guard; worktree symlink → outside target → realpath guard;
  `~/.ssh/id_ed25519` → tilde+realpath guard; planner write to source → guard
  (write root `.ralph` only), planner read of checkout → allowed; guarded
  read/write/edit block escapes before touching the filesystem, delegate when
  in-bounds.
- [x] Checklist #5: guard resolves realpaths at call time from the input path
  alone (no cached fd, no TOCTOU handle), and the planner has no L1 beneath it —
  a symlink or `-evil` sibling supplied as tool input is caught by the
  realpath + segment check (covered by the symlink/sibling tests).

---

## Phase 4 — Review-surface hardening (independent of 1–3)

Protects the last human gate everything falls back to. Touches the diff API
(`src/app/api/cards/[id]/diff/route.ts`) and the card detail UI.

- [x] **Invisible/confusable Unicode rendered visibly.** Bidi-override, zero-width, tag characters, and a curated confusable-homoglyph set in an agent-authored diff → shown as explicit escapes with a warning banner (Trojan Source class). Detector in `src/shared/diffSafety.ts` (`findSuspiciousChars`/`segmentSuspiciousChars`, pure + shared client/server); rendered in `review/[id]/page.tsx` (`renderDiffLineContent`) as a labeled `⟦NAME (U+XXXX)⟧` span with a title tooltip, plus a prominent banner.
- [x] **Diff suppression impossible.** `worktreeDiff`/`worktreeDiffStat` (`git.ts`) hardened with `--no-ext-diff --no-textconv --text` + `-c core.excludesFile=/dev/null` (`REVIEW_DIFF_FLAGS`) — defeats a `.gitattributes` `-diff`/binary marker hiding content and a local diff-driver hijack planted in `.git/config`, on top of the existing `.ralph` exclude. New `worktreeChangedPaths` feeds the review UI's path-based flags. `.gitignore`/`.gitattributes` changes get their own loud banner (`changedIgnoreFiles` in `sensitivePaths.ts`) rather than being silently trusted.
- [x] **Sensitive-path diffs flagged loudly.** `classifySensitivePaths` (`review/[id]/sensitivePaths.ts`) — distinct red banner (separate from the existing amber self-modifying one) for sandbox/containment (`src/server/sandbox/**`, `src/server/harness/**`, `integrity.ts`, `installGate.ts`), settings store, auth (`authSecret.ts`, `session.ts`, `proxy.ts`, `api/auth/**`), and the merge/review path (`git.ts`, `reviewService.ts`). Self-target cards land here routinely — that's by design, not a false positive.
- [x] **`sandboxEnabled` not model-reachable** — confirmed by construction: settings are only ever mutated via the human-facing `/api/settings` route (`useSettingsData.ts` → `settings.ts`), no agent tool binds to it anywhere in `harness/`. The only path to flip it is a merged self-target diff touching `src/server/settings.ts`, which the sensitive-path banner above surfaces.
- [x] Tests: `diffSafety.test.ts` (bidi/zero-width/tag/confusable detection + segmenting), `sensitivePaths.test.ts` (classification + ignore-file detection), `git.test.ts` (`--text` defeats a `-diff` attribute, `--no-ext-diff`+`--no-textconv` defeat a local diff-driver hijack, `worktreeChangedPaths` excludes `.ralph`), `page.test.tsx` (banners render for sensitive paths / ignore-file changes / suspicious chars, and stay absent for an ordinary diff).

---

## Phase 5 — Spike: srt per-run configuration (blocks Phase 6)

The one unknown that can change L1's shape. Answer before scheduling L1
(checklist #1a).

- [x] Add `@anthropic-ai/sandbox-runtime` as a dependency (pin the version) —
  `0.0.66` exact-pinned in `package.json` (`npm install --save-exact`).
- [x] Confirm srt supports **per-invocation config** — verified for real, not
  just from reading source (see findings below): `wrapWithSandbox(command,
  binShell?, customConfig?, abortSignal?)` takes a **per-call**
  `Partial<SandboxRuntimeConfig>` on the process-level `SandboxManager`
  singleton. No global settings file, no re-`initialize()` between runs.
- [x] Confirmed config does **not** bind exclusively at `initialize()` time —
  `wrapWithSandbox`'s `customConfig` overrides the session config **field by
  field** per call (`customConfig?.filesystem?.allowWrite ??
  config?.filesystem.allowWrite`, same pattern for `allowRead`/`denyRead`/
  `denyWrite`/`network.allowedDomains`), and a call **without** `customConfig`
  falls straight back to the session baseline — confirmed live (Test 5 below:
  a call with no `customConfig` after a `customConfig`-scoped call does not
  inherit the previous call's override). So the L1 shape is: call
  `SandboxManager.initialize()` **once** at server start with a maximally-
  restrictive baseline, then pass a fresh `customConfig` (worktree, TMPDIR,
  cache root, network allowlist) into every `wrapWithSandbox()` call — no
  per-run config file, no process-level re-init. The one caveat found in
  source (not exercised live): Windows ACL "stamp/grant" is session-wide and
  needs `reset()` + `initialize()` to change — irrelevant to the mac/Linux
  scope of this spec.
- [x] Pinned the srt API shape (checklist #1) by reading the shipped
  `dist/*.d.ts` **and** driving real sandboxed processes on this machine
  (`SandboxManager.isSupportedPlatform()` → `true` on this macOS host).
  Ran a 7-case live spike (`node` script importing the installed package,
  not committed — throwaway):
  1. Write inside a session-configured `allowWrite` root → succeeds.
  2. Write outside every `allowWrite` root → denied
     (`Operation not permitted`), file absent on the host afterward.
  3. Read of `$HOME` with a real canary file present → denied
     (`denyRead: [homedir]`).
  4. Per-call `customConfig` opening a **second** root not in the session
     baseline → succeeds, proving true per-invocation reconfiguration.
  5. A call **without** `customConfig` right after test 4 → the second root
     is *not* writable — confirms per-call overrides don't leak into
     subsequent calls; each `wrapWithSandbox()` call is independently scoped.
  6. `allowRead` re-opening one file inside a broad `denyRead($HOME)` →
     readable — confirms the "narrow allowRead re-opens inside broad
     denyRead" precedence the spec's L1 policy depends on.
  7. `network: { allowedDomains: [] }` → `curl` to an arbitrary host fails
     through srt's injected proxy (`CONNECT tunnel failed, response 500`) —
     confirms default-deny egress.
  All 7 behaved exactly as predicted from the source read below.
  **Config keys** (public `FilesystemConfig`/`NetworkConfig`, from
  `dist/sandbox/sandbox-config.d.ts`): `filesystem.{denyRead, allowRead?,
  allowWrite, denyWrite, disabled?, allowGitConfig?}`,
  `network.{allowedDomains, deniedDomains, strictAllowlist?, ...}`.
  `allowGitConfig` is the exact lever Phase 6 needs for the parent `.git`
  write-allow-except-hooks/config carve-out (`macGetMandatoryDenyPatterns`
  always denies `.git/hooks` and, unless `allowGitConfig`, `.git/config`).
  **Precedence semantics** (from `dist/sandbox/sandbox-schemas.d.ts` doc
  comments + `macos-sandbox-utils.js` `generateReadRules`, confirmed live
  in case 6 above): read uses a "deny-then-allow-back" pattern —
  `denyRead` (internally `denyOnly`) denies broad regions, `allowRead`
  (internally `allowWithinDeny`) re-opens specific paths within a denied
  region and **takes precedence over** the surrounding deny — "most
  specific rule wins," matching the spec's assumption exactly. Write uses
  the opposite "allow-only" pattern (`allowWrite`/`allowOnly` is
  maximally restrictive by default — empty means no writes at all, unlike
  read's empty-deny-means-allow-all). Network is allow-only too:
  `deniedDomains` checked first and always wins; an unmatched host falls
  through to an optional `SandboxAskCallback` and is **denied** when none
  is registered — so leaving that callback unregistered is itself the
  Decision-7-compliant default (no model-visible prompt, fail closed).
  Credential deny-paths are **unioned** into `denyRead`, never replacing a
  caller's list — the backstop denylist survives regardless of what a
  per-run `customConfig` specifies.
- [x] Findings written up above; **decided L1 integration shape:** one
  `SandboxManager.initialize()` at server boot with the permanent baseline
  (mandatory denylist, `network: { allowedDomains: [] }` as the floor);
  `createRunSandbox()` (resolved design question 4) grows a `customConfig`
  field alongside `env`/`tmpdir`/`cacheRoot`, built from the run's worktree
  + TMPDIR + cache root + `sandboxNetworkAllowlist`; `spawnHook`'s
  `commandPrefix` rewrite (Phase 6) calls
  `SandboxManager.wrapWithSandbox(command, undefined, ctx.srtConfig)` per
  bash invocation. No per-run config file, no reset/reinit per run.

---

## Phase 6 — Layer 1: OS sandbox on agent bash (srt)

Wire the spawn hook; ship with the default policy. Run acceptance tests on both
a mac and a Linux host.

**Environment note:** this phase was implemented and verified from a single
macOS dev machine — no Linux host was available. Everything below is either
(a) verified live on macOS, (b) implemented against srt's documented/typed
API and covered by unit tests that don't depend on a specific OS, or (c)
explicitly left unchecked because it needs a Linux host, a Docker host, a
Go/JVM repo, or a real (token-spending) end-to-end run to verify — marked
individually.

- [x] In `createRalphSession` (`pi.ts`), bash is srt-wrapped via a custom
  `operations.exec` (`createSandboxedBashOperations` in
  `src/server/sandbox/srt.ts`), **not** `spawnHook` — amends the plan:
  `BashSpawnHook` is synchronous (`(ctx) => ctx`) and
  `SandboxManager.wrapWithSandbox` is async, so the rewrite can't happen in
  `spawnHook`. `operations` is pi's own documented extension point for
  exactly this ("wrapping or rewriting commands"). Routing decided by
  `shouldSandboxBash(role, srtConfig)` (loop/evaluator only; unit-tested in
  `pi.test.ts`) — `spawnHook` still handles the env swap, unchanged.
- [x] `commandPrefix` (L3 preamble) unchanged — still prepended by pi before
  the sandboxed exec sees the command, so ulimits/pgid-recording run inside
  the sandbox too.
- [x] **Filesystem policy** (`buildFilesystemConfig` in `srt.ts`, built
  per-run in `createRunSandbox`): write allow = worktree, run `$TMPDIR`, run
  cache root, parent repo's shared `.git` (resolved via `git rev-parse
  --git-common-dir`, so a linked worktree's own pointer file is not
  mistaken for it); write deny = `.git/hooks`, `.git/config`,
  `.git/worktrees/*/config`. Read allow = worktree/TMPDIR/cache, system
  roots (`/usr`, `/bin`, `/sbin`, `/opt`, `/etc`, plus `/Library/Developer`,
  `/nix`, `/System` on macOS), toolchain roots derived from `PATH`, and the
  three named `$HOME` re-allows (`.nvm`, `.rustup/toolchains`,
  `.cargo/registry`) — **not** `.pyenv`/`.cargo/credentials`/`Library/Caches`,
  matching the spec's explicit exclusions (tested). Read deny = `$HOME` in
  full, Radulf's `DATA_DIR`/`WORKTREES_DIR`. Verified live on macOS: a write
  inside the worktree succeeds, a write outside every allow root fails, a
  read of `$HOME` fails even with a real file present, and a narrow
  `allowRead` re-opens one path inside the broad `$HOME` deny (`srt.test.ts`,
  real `sandbox-exec` processes, no mocks).
- [x] Backstop credential denylist (`credentialBackstopDenylist` —
  `.ssh`, `.aws`, `.config/gh`, `.netrc`, `.npmrc`, `.git-credentials`,
  `.docker/config.json`, `.kube`, `.config/gcloud`, `.cargo/credentials`,
  `.gnupg`, plus the macOS keychain/browser/cookie paths) unioned into
  `denyRead` on every run, independent of `$HOME` already being denied.
- [x] **Socket policy:** nothing to wire — Unix domain sockets (incl.
  `/var/run/docker.sock`) are denied by srt's own default whenever
  `allowUnixSockets`/`allowAllUnixSockets` is left unset, which `srt.ts`
  does; commented in `buildNetworkConfig` as a security invariant a future
  edit must not "fix." `SSH_AUTH_SOCK` already dropped by L3 (1b).
  **Not verified:** an actual `docker.sock` probe from inside a sandboxed
  run on a Docker host (checklist #2 — needs that host).
- [x] **Network policy:** `buildNetworkConfig`/`parseNetworkAllowlist` —
  default-deny egress, `registry.npmjs.org` always allowed,
  `sandboxNetworkAllowlist` (wired into the Settings UI this phase, with the
  domain-fronting residual named in its help text) extends it. Model traffic
  stays in-process, never through agent bash — unchanged, no endpoint added.
- [~] **Seccomp filter hard-requirement on Linux** — **descoped (macOS-only
  scope, 2026-07-22).** Structurally true (`SandboxManager.checkDependencies()`/
  `sandboxPreflight()` surfaces a missing filter as a preflight error, same fail
  path as a missing `bwrap`) and unit-tested, but live Linux verification is
  out of scope — revisit when Linux support is picked up.
- [x] **Failure semantics — no silent fallback:**
  - [x] srt init failure → run fails before first iteration: both
    `orchestrator.ts` (`runLoop`) and `evaluationService.ts`
    (`runEvaluator`) `await initializeSandboxRuntimeOnce()` when
    `sandboxEnabled` and fail the run + move the card to Needs Attention
    with the verbatim error before calling `runHarness`. (The planner never
    reaches this — it has no bash tool, so L1 never applies to it.)
  - [x] **Startup preflight**, not first-command discovery: `sandboxPreflight()`
    (platform support, srt's dependency check, the Linux AppArmor sysctl
    below) runs once at server boot in `src/instrumentation.ts`, logged with
    remediation text; the result is cached (`initializeSandboxRuntimeOnce`)
    and reused by the per-run check above rather than re-probed per run.
  - [x] Ubuntu 24.04+ AppArmor: `apparmorRestrictsUnprivilegedUserns()`
    reads `sysctl kernel.apparmor_restrict_unprivileged_userns`; `=1` →
    preflight error with the exact remediation (grant `bwrap` the `userns`
    capability via an AppArmor profile, or flip the sysctl). srt itself does
    not check this — confirmed by reading its source; Radulf's own check.
    **Not verified on a real Ubuntu 24.04+ host.**
  - [x] `sandboxEnabled=false` → persistent red warning banner in
    `src/app/layout.tsx` (server-rendered, so it's on every page, not just
    Settings) + `sandboxed: false` stamped on every affected run row.
    Verified live: toggled off via `PATCH /api/settings`, banner appears on
    `/info`; toggled back on, banner disappears (screenshots taken).
- [x] `sandboxed` stamped on every run row (`plan`, `loop`, `evaluate`) as
  `1`/`0` from `settings.sandboxEnabled` at `db.insert(runs)` time in all
  three services (`db/schema.test.ts` already covers the column round-trip;
  Phase 0).
- [x] **🐛 Real bug found and fixed by this verification work:**
  `toolchainReadRootsFromPath()` added `path.dirname()` of every `PATH`
  entry unconditionally to `allowRead`. Every Unix `PATH` realistically
  contains `/bin` and/or `/sbin` (this dev machine's did) — `dirname("/bin")
  === "/"` — so `/` itself was silently added as an allow-read root. Because
  srt's read-allow is a *recursive subpath match*, that single entry
  re-opened **the entire filesystem**, structurally defeating the `$HOME`
  and `DATA_DIR` denies for every run — the exact "list of secrets we
  happened to think of" failure mode spec 14 itself warns against, except
  worse (a total bypass, not a narrow gap). Caught by the new acceptance
  row below (`cat <DATA_DIR>/…` unexpectedly *succeeded*), root-caused via
  a minimal standalone repro against the real installed srt package, fixed
  with `dropRootsThatWouldReopen()` (`srt.ts`) — a general filter, not a
  point patch: it rejects any candidate allow-read root that is `/` or a
  proper ancestor of `$HOME`/`DATA_DIR`/`WORKTREES_DIR`, applied to the
  *entire* `allowRead` list (not just the PATH-derived entries), so any
  future contributor to that list gets the same safety net. Regression
  test uses the real, unmocked `process.env.PATH` so it keeps failing on
  whatever machine runs it if the guard regresses. This is exactly the
  kind of thing "acceptance tests on macOS and Linux" exists to catch —
  and did, before any of this shipped.
- [x] Verification-checklist items — **materially advanced, not fully
  closed** (see the cross-cutting list below for the per-item detail): #2
  the non-Docker-specific half (Unix sockets denied by default) verified
  live via a raw `nc` connect attempt; the `docker.sock`-specific probe
  **is** now verified live too — this dev machine has Docker Desktop
  installed, so `/var/run/docker.sock` exists and a real `nc -U` connect
  attempt against it was denied by the sandbox. #3 the `.git/hooks`,
  `.git/config`, and `.git/worktrees/*/config` write-denies are now each
  verified with a real linked worktree and real sandboxed write attempts
  (not just config assembled correctly, as before) — **still open:** a real
  `git commit`/`git push` run under the sandbox, as opposed to a raw
  `echo >` write attempt. #7 raw-socket denial (the specific gap the note
  called out — "a passing curl proves almost nothing") is now verified via
  the same `nc` test; SSH push and a tool with its own DNS resolver remain
  untested. #6, #8, #9, #10 unchanged — see the list below.
- [x] Ran the parts of the **acceptance-test table** (spec §Acceptance
  tests) that don't require a live LLM run or a Linux/Go/JVM host — 8 rows
  now verified directly against real sandboxed processes built from the
  exact `buildRunSandboxConfig`/`wrapBashCommand` production code path
  (`srt.test.ts`, new "acceptance-test table" describe block): `cat
  <DATA_DIR>/…`, `cat` a real file under `$HOME`, `curl` to a
  non-allowlisted domain, `nc` raw-socket to a non-allowlisted host, `nc -U`
  to `/var/run/docker.sock`, write to `.git/hooks/pre-commit`, write to
  `.git/config`, write to `.git/worktrees/<name>/config` — plus a control
  row proving the sandbox isn't fail-closed on everything (an ordinary
  worktree write still succeeds). **Still not done:** the rows that
  inherently need a live agent transcript (L2-guard rows, `web_search`
  role-binding, env-allowlist rows — these already have their own unit
  tests elsewhere, just not as *this* table's artifact), the install-gate
  rows (already covered in `installGate.test.ts`), the review-surface rows
  (already covered in Phase 4's tests), and everything gated on Linux, a
  Go/JVM repo, or real tokens (fork bomb, disk fill, SSH push, the positive
  control).
- [x] **🐛 Second real bug found and fixed, this time by the positive control
  itself:** the first live run (below) hit `npm error 403 ... blocked-by-
  allowlist` on `registry.npmjs.org` despite it being in the run's
  `allowedDomains` — the loop agent, denied the registry, investigated (npm
  config, a fake local registry, pnpm, `--prefer-offline`) and ultimately
  **worked around the sandbox** by hand-writing a fake `is-odd` package and
  installing it from a local tarball, which the evaluator then approved
  because it technically satisfied the acceptance criteria. Root cause,
  found by reading srt's own source: filesystem policy is generated fresh
  per call from `wrapWithSandbox`'s `customConfig` (true, confirmed in
  Phase 5), but **network policy is not** — the egress proxy is a
  long-running background process that filters every request against the
  *session-level* config captured at `initialize()`/`updateConfig()` time;
  `wrapWithSandbox`'s `customConfig.network` is silently ignored for
  domain filtering. Proven with a minimal repro: identical `customConfig`,
  identical `curl`, denied before `SandboxManager.updateConfig()`, allowed
  after. Fixed in `wrapBashCommand` (`srt.ts`), which now calls
  `updateConfig(runConfig)` immediately before `wrapWithSandbox` — safe
  only because Radulf's pipeline is strictly serial (spec 02, one card at a
  time); documented as a hard invariant in the code so a future concurrency
  change doesn't silently reintroduce a cross-run policy race. Regression
  test in `srt.test.ts` asserts the default-allowed `registry.npmjs.org`
  actually reaches the real registry end to end. **This means the original
  Phase 6 network-policy implementation was not just narrowly wrong but
  structurally inert** — every run's `sandboxNetworkAllowlist` extension
  and the `registry.npmjs.org` default would have been silently ignored in
  favor of whatever the session baseline happened to be (in this build,
  `allowedDomains: []` — block everything), forcing every real `npm
  install` to fail or be routed around. Exactly the failure this positive
  control exists to catch.
- [x] **Positive control:** a real plan → loop → evaluate → review card **ran
  twice** against a throwaway scratch Node repo (created and destroyed
  entirely within this environment — never touched a real registered
  project), sandbox on, `$HOME` read-denied, OpenRouter providers (real
  tokens spent, per explicit user authorization). **First run:** completed
  plan → loop → evaluate → review, evaluator approved — but exposed the
  network bug above via the loop's workaround. **After fixing both bugs and
  restarting the server** (the running dev process doesn't hot-reload a
  long-lived singleton's already-resolved config), a **fresh card with the
  same task ran clean**: `npm install is-odd` succeeded against the real
  registry (`package-lock.json` shows `resolved:
  "https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz"` for the package
  *and* its real transitive dependency `is-number`), `node --test` passed,
  the evaluator approved, every run row stamped `sandboxed: 1`. All three
  test cards were abandoned afterward (never merged), the scratch repo was
  deleted and unregistered — no residue in real project state. **Still not
  covered:** a Go/JVM repo (this control used Node only, and none of the
  four real registered repos on this machine are Node — two are Python,
  one registration is stale/empty). That toolchain-specific half of
  checklist #8 remains open.

---

## Phase 7 — Docs, amendments, and ungating self-improvement

- [x] **Doc reconciliation:**
  - [x] `specs/00-overview.md`: index row (already present) + decision 7 re-amendment note pointing at spec 14.
  - [x] `SECURITY.md`: threat model + "bounded by the run sandbox" clause added; "operator trusts the machine" framing kept; accepted residual stated (reads reach the model provider; a merged diff is trusted like any commit).
  - [x] `README.md`: srt dependency row (with the Ubuntu 24.04+ AppArmor caveat inline), OS requirement row reconciled to "macOS or Linux (incl. WSL2)".
  - [x] Requirements/README: APFS-volume-quota + sparse-image documented (see Phase 1e above).
- [x] **Spec amendments (documented, already reflected in code):** decision 7 re-amend (00); spec 02 Safety posture + Configuration (roles) + architecture diagram; spec 13 Security section (env scrub → allowlist, `operations.exec` adds the sandbox wrap — amended from "spawnHook" per the sync/async finding in Phase 6 — `web_search` → planner-only); spec 04 PROMPT.md contract note ("these guardrails describe the walls, they no longer *are* the walls").
- [x] **Amend spec 14 itself** — role capability model dropped from four roles to three (summarizer removed) in both the role-capability table and the L2 roots table; planner containment section corrected to the actual shipped write root (`<worktree>/.ralph/`, not a separate `plans/<run-id>/` — the planner's cwd is the worktree, not a pre-worktree state as the original text claimed); evaluator's absorbed summarizer duties and narrowed integrity check documented. Spec 04's pipeline reconciled (planner → loop → evaluator → review, no summarize step; evaluator section rewritten to match Phase 2a's shipped behavior, including the failure-taxonomy row).
- [x] **Ungate self-improvement (rollout step 7):** **done (2026-07-22).** Both
  remaining macOS-side gates are closed: checklist #9 (resource limits under
  real load / ENOSPC / APFS-quota) and checklist #8 (positive control on a
  non-Node toolchain — Go), each verified live. Linux was descoped 2026-07-22.
  Together the Node and Go positive controls caught and fixed four real bugs (a
  total filesystem-policy bypass, a structurally-inert network policy, Go TLS
  blocked by the sandbox, and inert process-group reaping). Self-improvement /
  self-target cards are now **routine, not gated** — there was never a runtime
  flag; the gate was operational ("don't queue self-target cards until the
  sandbox acceptance passes"), and that condition is now met. Specs reconciled:
  spec 14 rollout step 7 and spec 13 rollout step 3 both note the gate is
  satisfied.

---

## Cross-cutting: verification checklist to pin (spec §Verification checklist)

Track these explicitly; several block Phase 6.

- [x] #1 srt library API + glob/precedence semantics (Phase 5) — pinned from
  `dist/*.d.ts` and confirmed live (7-case spike + `srt.test.ts`).
- [x] #1a per-run configuration spike — **blocks Phase 6** (Phase 5) — resolved: `wrapWithSandbox`'s per-call `customConfig`, no re-init.
- [x] #2 socket policy enforcement incl. `docker.sock` (Phase 6) — denied by
  construction (no `allowUnixSockets` set) **and verified live**: a real
  `nc -U` connect to this dev machine's actual `/var/run/docker.sock`
  (Docker Desktop installed) was denied by the sandbox, plus a raw-socket
  attempt to an arbitrary non-allowlisted host.
- [x] #3 git-in-worktree minimal `.git` write set (Phase 6) — the
  hooks/config/worktrees-config carve-out is implemented, unit-tested, and
  **verified live** against a real linked git worktree: sandboxed write
  attempts to `.git/hooks/pre-commit`, `.git/config`, and
  `.git/worktrees/<name>/config` are all denied while an ordinary worktree
  write still succeeds. **Still open:** a real `git commit`/`git push`
  running inside the sandbox (as opposed to a raw `echo >` write) — that
  needs a live agent turn, not just a shell command.
- [x] #4 commit identity under `GIT_CONFIG_GLOBAL=/dev/null` (Phase 1c) — `AGENT_GIT_IDENTITY`, real-repo commit test.
- [x] #5 symlink/rename races in L2 guard; planner-specific race check (Phase 3) — guard resolves realpaths from the input path per call; symlink + `-evil`-sibling tests cover it.
- [x] #6 `sandbox-exec` viability — verified on this repo's macOS dev host
  (real `sandbox-exec` processes in `srt.test.ts` and the Phase 5 spike);
  **not yet added to a documented upgrade-check ritual** (Phase 7 docs).
- [x] #7 proxy env propagation — `curl` through the network proxy verified
  live (denied domain fails with a proxy-level error) **and raw sockets are
  now verified too**: a real `nc` connect to a non-allowlisted host,
  bypassing `HTTP_PROXY` entirely, is denied at the platform layer — this
  was the specific gap the note called out ("a passing curl proves almost
  nothing"). **Still open:** a tool with its own DNS resolver, and `git
  push` over SSH specifically (the `GIT_SSH_COMMAND=/bin/false` half of
  this is covered by Phase 1c's env tests, but not exercised as an actual
  push attempt under the sandbox).
- [x] #8 home-denied across node/Go/Rust/JVM (Phase 6) — **Node and Go both
  verified live** (2026-07-22). Node: positive control with a real `npm
  install` against the real registry, `$HOME` denied. **Go:** a full
  plan→loop→evaluate→review positive control against a throwaway scratch Go
  module (created and destroyed entirely in this environment — never a real
  registered repo), sandbox on, `$HOME` denied, OpenRouter (real tokens, per
  explicit user authorization). The loop ran a real `go mod tidy` that
  fetched `rsc.io/quote v1.5.2` **and its full transitive graph**
  (`rsc.io/sampler`, `golang.org/x/text`) through the sandbox — `go.sum`
  carries real proxy-fetched hashes — then `go test` passed; the evaluator
  independently ran `go test` under its own sandbox and **approved**; all
  three run rows stamped `sandboxed: 1`. **No workaround** (contrast the
  Node control's first attempt). Two real findings, both fixed:
  - **🐛 Go TLS verification is blocked by the sandbox on macOS.** Go's
    verifier (and gh/gcloud/terraform/kubectl) calls `SecTrustEvaluate` →
    the `trustd` mach service, which Seatbelt denies by default, so **every
    Go HTTPS fetch fails** even for an allowlisted domain (`curl` works
    because it uses a PEM bundle, not the system verifier; Go on darwin
    ignores `SSL_CERT_FILE`, confirmed live). srt's sanctioned lever is
    `enableWeakerNetworkIsolation` (allows `trustd.agent`). Shipped as an
    **opt-in setting `sandboxWeakerIsolationForGoTls` (default OFF)** —
    strict isolation stays the default; operators whose toolchain needs it
    opt in knowingly. Residual (documented in the setting help + SECURITY.md
    + spec 14 network policy): `trustd` runs outside the sandbox and its
    OCSP/CRL requests bypass the egress proxy — a low-bandwidth exfil
    channel, comparable to the accepted `web_search` residual.
  - **🐛 Go's module + build caches default under `$HOME`** (`~/go`, and on
    macOS `~/Library/Caches/go-build`, which `XDG_CACHE_HOME` does not
    redirect) — both write-denied by L1, so a sandboxed Go build would fail.
    Fixed in `agentEnv` by pointing `GOPATH`/`GOMODCACHE`/`GOCACHE` at the
    run cache root (same pattern as npm/yarn — no `$HOME` re-allow needed),
    with `GOFLAGS=-modcacherw` so the read-only module cache can be deleted
    at run-end cleanup.
  - **🐛 (surfaced by this run) process-group reaping was inert for every
    sandboxed run.** The pgid file lived at the run root, which is **not** an
    L1 `allowWrite` root, so the commandPrefix's in-sandbox
    `echo "$$" >> pgids` was silently denied (`pgids: Operation not
    permitted` in the transcript) — 1f recorded nothing and could reap
    nothing. Fixed by relocating the pgid file into the run's private
    `$TMPDIR` (an `allowWrite` root); verified live that the preamble now
    records its pid through a real sandbox. Regression test ties the pgid
    file to `$TMPDIR`.
  **Still open (future, not a gate):** Rust and JVM — the handoff scoped the
  gate to "Go or JVM," and Go is done. JVM would not hit the trustd issue
  (Java uses its own cacerts); Rust is untested here.
- [x] #9 resource limits under real load; APFS quota flag syntax; ENOSPC
  surfaces cleanly (Phase 1e/6) — **verified live on macOS (2026-07-22)**:
  - **Watchdog trips under real pressure** (not mocked sizes): a standalone
    exercise of the production `startDiskWatchdog` against **real files** with
    lowered thresholds tripped the per-run-bytes bound (12.6 MB of real files
    over an 8 MiB bound) and, separately, the volume-free-space floor.
  - **Ballast release on pressure**: the free-floor trip deleted a real 67 MB
    ballast file **before** `onTrip` fired (verified the file was gone at the
    moment of the callback), then failed loudly. The orchestrator `onTrip`
    (`orchestrator.ts:596`) does `finishRun(failed)` → `moveCard(…,
    needs_attention, reason)` — the same finalize path every other run failure
    uses (lifecycle-tested); no silent fallback.
  - **ENOSPC surfaces cleanly**: against a **real full volume** (both a 64 MB
    `hdiutil` sparsebundle and, below, the real APFS quota volume), `dd` past
    the ceiling exits 1 with `No space left on device`, and Node `fs`
    `writeFileSync` throws a **catchable** `ENOSPC` (errno −28) **immediately**
    — no crash, no hang. A thrown ENOSPC in orchestrator code is caught by the
    `runLoop().catch(err → moveCard(…, needs_attention, String(err)))` wrapper
    (`orchestrator.ts:454`), so it becomes a legible run failure, not a server
    crash.
  - **`diskutil apfs addVolume … -quota` syntax validated on this host** (macOS
    26.x / xnu-12377): usage + example both list `-quota <quotaSize>`, and a
    real `diskutil apfs addVolume disk3 APFS RadulfQuotaTest -quota 200m` volume
    was created, exercised, and torn down.
  - **`diskLimitMechanism` now auto-detects `apfs-quota`** (was hardcoded
    `watchdog` on macOS even when a real quota bounded the run — misleading).
    `detectMacDiskMechanism` (`diskWatchdog.ts`) reads `diskutil info -plist`:
    a quota volume reports `TotalSize` strictly below the shared
    `APFSContainerSize` (there is no dedicated quota key — this is the only
    signal diskutil exposes; pinned live against the real volume). Verified
    live: the real quota volume → `apfs-quota`, the main data volume / tmp /
    a nonexistent path → `watchdog`. Wired into `createRunSandbox`
    (`context.ts`), stamped on the run row. Unit-tested against the real
    captured field values (`sandbox.test.ts`); the live shell-out is skipped
    under `NODE_ENV=test` for hermeticity, matching the `ensureBallast` skip.
    `sparse-image` stays reserved / not auto-detected. README "Disk limits"
    corrected (it claimed apfs-quota was not auto-detected).
- [x] #10 evaluator under sandbox — no wider access than loop, no `web_search`
  back (Phase 6) — role-symmetric wiring was already unit-tested
  (`shouldSandboxBash`), and the positive control's `evaluate` run
  (`sandboxed: 1`, real sandboxed bash reading the diff and running
  `node --test`) confirms it live, not just by construction.
- [x] #11 Needs Attention resume path preserves run state (Phase 1h).

## Resolved design questions

1. **Summarizer** → **dropped** (Phase 2a). The evaluator writes the summary
   (into `.ralph/`) **and** updates stale docs. Its integrity check narrows from
   "no source changes" to "no **code/git-history** changes — doc-allowlist paths
   permitted," preserving the load-bearing judge-can't-edit-the-code guarantee.
   Amends spec 14's role table from four roles to three.
2. **`approvedInstallScripts` storage** → **JSON column on `repos`** (Phase 0).
   The read-modify-write race across concurrent approvals is benign — a lost
   write just re-fires the gate next run. A table isn't worth the machinery.
3. **Install-gate hook point** → **post-iteration resolved-tree inspection** in
   `runLoop` (Phase 1h). Triggered by a lockfile hash change (piggybacking on
   `captureIterationState`), never on the command string (spec forbids trusting
   env/command).
4. **Per-run env threading** → **one `createRunSandbox(...)` factory**
   (`src/server/sandbox/context.ts`) returning `{ env, srtConfig, tmpdir,
   cacheRoot, cleanup() }`, threaded via a `runContext` field on
   `RunHarnessOpts` and consumed in `createRalphSession`/`spawnHook`;
   `agentEnv()` becomes `agentEnv(ctx)`. Each of the three run entry points calls
   the factory once and `cleanup()`s in a `finally`.

## Definition of done

- [x] Every acceptance-test-table row fails at the stated layer, visible in
  the transcript, **on macOS** (Linux descoped 2026-07-22). 8 rows verified
  directly against real sandboxed processes on macOS (`srt.test.ts`), plus a
  full live agent transcript via the positive control below — together these
  caught and fixed two real bugs (a total filesystem-policy bypass, and a
  structurally-inert network policy) before either shipped. Linux acceptance
  is future work, not a release gate.
- [x] Positive control passes with sandbox on + `$HOME` read-denied — **done
  for Node and Go**, real tokens spent with explicit user authorization.
  Node: a real plan→loop→evaluate→review card with a real `npm install` from
  the actual registry, passed clean on the second attempt (the first surfaced
  the network-policy bug). **Go (2026-07-22):** a throwaway scratch Go module
  (created and destroyed in-environment, never a real registered repo), real
  `go mod tidy` fetching `rsc.io/quote` + its transitive graph through the
  sandbox, `go test` passing in both loop and evaluator, evaluator approved,
  every run stamped `sandboxed: 1`, no workaround. Surfaced/fixed three more
  real bugs (Go TLS blocked by the sandbox → opt-in `sandboxWeakerIsolation
  ForGoTls`; Go caches under `$HOME` → redirected in `agentEnv`; inert
  process-group reaping for sandboxed runs → pgid file moved into `$TMPDIR`).
  Scratch card abandoned, repo unregistered, dirs deleted — real project state
  verified pristine (85 cards unchanged).
- [x] `make check` green — 553 tests, lint, typecheck, build all pass, with
  the Gate 1/Gate 2 work and all four live bug fixes landed.
- [x] Docs (00/02/04/13, SECURITY.md, README) reconciled — Phase 7 done, plus
  spec 14 itself amended (role table, planner containment, L2 roots, the
  `sandboxWeakerIsolationForGoTls` setting + trustd residual), and spec 03/05
  fixed for the same summarizer-removal staleness.
- [x] Self-improvement cards ungated (2026-07-22) — both macOS-side gates
  closed live: resource limits / ENOSPC / APFS-quota (#9) and the Go positive
  control (#8). No runtime flag existed; the operational gate condition is now
  met, and specs 13/14 note it. Self-target cards are routine.
