VERDICT: revise

## Summary

The split itself works and is well built: roles parse from one env var, the boot sequence moved into `src/server/boot.ts` with a role gate and a timer pump, the web role gets a passive orchestrator, migrations run under `BEGIN EXCLUSIVE` on a separate lock DB, the auth secret is created with `wx` and re-read on `EEXIST`, `dist/worker.mjs` bundles with no `next` import, and `make check-split` drives a card Todo → In Review across a web-only `next dev` and a worker-only Node process. I also raced three fresh worker boots against one empty data dir: one 64-hex secret, 17/17 migrations applied once, no lock/EEXIST errors, all three exit 0 on SIGTERM.

Two things block approval: `make lint` (and therefore `make check`) fails on the new test file, and one part of the card's stated web-role behaviour is not implemented (an improvement run created through the web API still drives a pi session inside the web process).

## What failed

### 1. `make lint` exits non-zero — acceptance criterion failure (also fails `make check`)

```
$ make lint
/…/src/server/splitProcesses.test.ts
   75:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  286:19  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
✖ 2 problems (2 errors, 0 warnings)
make: *** [Makefile:78: lint] Error 1
```

Lint is clean when that one file is excluded (`eslint . --ignore-pattern src/server/splitProcesses.test.ts` exits 0), so both errors are introduced by this card. Fix in `src/server/splitProcesses.test.ts`:

- line 75: change the `api()` helper's return type from `Promise<{ status: number; json: any }>` to `Promise<{ status: number; json: unknown }>` (or make it generic, `api<T = unknown>(…): Promise<{ status: number; json: T }>`), and narrow at the call sites (`repo.json as { id: string }`, `card.json as { id: string }`, `listed.json as Array<…>` is already cast).
- line 286: replace `let detail: any;` with a typed shape, e.g. `let detail: { card?: { status?: string }; runs?: Array<{ kind: string; status: string; iterationsDone: number | null; exitReason: string | null }> } | undefined;`, and drop the later `detail.runs as Array<…>` cast accordingly.

Then re-run `make lint` and `make check-split` and confirm both exit 0.

### 2. A web-only process still constructs a pi session for improvement runs — card description not implemented

The card says a `web`-role process "never resumes improvement-run drivers … and never constructs a pi session". Spec 25 names scoping turns and provider login as the only pi sessions that stay in web (decision 9); improvement-run drivers are explicitly worker-side.

Today `POST /api/improvement-runs` (`src/app/api/improvement-runs/route.ts`) calls `createImprovementRun()` in `src/server/improvementRuns.ts`, which ends with `void driveRun(row.id)` (line 217). `driveRun → runDriverLoop → proposeOneImprovement → runHarness` (`src/server/improvementProposer.ts:62`) — that is a pi session running inside the web-only process. Nothing on the worker side would adopt the run either: the worker calls `resumeImprovementRuns()` exactly once at boot (`src/server/boot.ts:51`), so a run created after the worker booted is only ever driven by the web process.

Minimal fix that stays inside this card's scope (no claims, no heartbeats, no cross-process control):

- In `createImprovementRun()`, only call `void driveRun(row.id)` when `hasRole("worker")` (import `hasRole` from `./roles`); a web-only process just inserts the row and emits `improvement.started`.
- In `src/server/boot.ts`, have the worker's pump timer also call `resumeImprovementRuns()` (it is already idempotent per process through `driverGuard()` — `driveRun` returns at once for a run it is already driving), so the worker adopts a run the web process created within one pump interval. Update the `resumeImprovementRuns` doc comment, which currently reads as boot-only.
- Add a test: in `src/server/orchestrator.roles.test.ts` (or a new `improvementRuns.roles.test.ts`) assert that with `RADULF_ROLES=web`, `createImprovementRun()` leaves the row `running` and does not call `driveRun`, and in `src/server/boot.test.ts` assert the worker timer calls `resumeImprovementRuns` more than once.

(An alternative consistent with `retryFailedStep`/`approveInstallScripts` is to refuse with a 409 `ClientError` in a passive process; either is acceptable, but the timer adoption is what makes the UI action keep working from a web-only process.)

## What I verified (all from the repository root)

- New-behaviour tests: `npx vitest run src/server/roles.test.ts src/server/orchestrator.roles.test.ts src/server/boot.test.ts src/db/migrationLock.test.ts src/server/authSecret.test.ts` → 23 passed, exit 0.
- All `test -f` / `grep` structural checks pass, with one literal exception noted below.
- `make build-worker` exits 0, `dist/worker.mjs` exists, `! grep -q 'from "next' dist/worker.mjs` passes; the bundle's externals are only `better-sqlite3`, `drizzle-orm*`, `nanoid`, `typebox`, `@earendil-works/pi-coding-agent`, `@anthropic-ai/sandbox-runtime/...` and `node:*`.
- `RADULF_ROLES=worker RADULF_DATA_DIR="$(mktemp -d)" timeout --preserve-status 15 node dist/worker.mjs` prints `[radulf] roles: worker`, `[radulf] shutdown clean — exiting`, `exit=0`.
- Regression floor: `npx vitest run src/server/orchestrator.lifecycle.test.ts src/server/mockPipeline.test.ts src/server/orchestrator.scoping.test.ts src/server/orchestrator.test.ts "src/app/api/cards/[id]/move/moveRoute.test.ts" src/app/api/cards/cardsRoute.test.ts` → 131 passed, exit 0; none of those files is modified by the branch.
- `make typecheck` exits 0. `make check-split` exits 0 (3 tests, ~5s). `Dockerfile`, `compose.yaml`, `src/server/harness`, `src/server/sandbox` untouched; `make dev`/`make start` recipes and the Dockerfile `CMD` unchanged.
- Full suite (`make test`, run once): 1162 passed, 15 failed, 30 skipped. The 15 failures are exactly the card's environmental list — `src/server/bookkeeping.test.ts` (`EROFS mkdtemp '/tmp/…'`), the stall/watchdog tests in `src/server/harness/index.test.ts` and `src/server/harness/streamLiveness.test.ts` (`ENOENT mkdir '/tmp/ralph-stall-test'`), and the real-runtime rows in `src/server/sandbox/srt.test.ts`. Nothing else fails.
- `make build`: `build-worker` succeeds; `next build` fails only on fetching Geist/Geist Mono from Google Fonts (offline sandbox, pre-existing, excluded by the criteria).

Environment note: `TMPDIR` in this run pointed at `/tmp/claude`, which does not exist and cannot be created (`/tmp` is read-only). I ran the commands above with `TMPDIR=/var/lib/radulf/runtmp/<run>/tmp` — the run's writable scratch, outside the worktree — rather than inside the checkout.

## Notes for the human reviewer (not blocking)

- `grep -q 'from "@/server/boot"' src/instrumentation.ts` fails literally: instrumentation uses `await import("@/server/boot")`, the same Node-only dynamic-import pattern the original `register()` used (a static import there would pull better-sqlite3 into every runtime Next compiles instrumentation for). The criterion's intent — instrumentation delegates to the boot module — is met; I did not ask for a change.
- From a web-only process, `pauseCard`/`pauseEpic` only add to the process-local `pausedCards` set and `cancelCard` only flips DB rows and aborts a controller that lives in the worker, so pause has no effect on a loop the worker is running and cancel takes effect only at the worker's next DB check. The card explicitly defers cross-process control (spec 25 decision 4), so this is expected, but worth knowing when testing the split by hand.
- Passive-mode `retryFailedStep` for `plan`/`evaluate` and `approveInstallScripts` return 409 from a web-only process (they would start a stage in-process); loop retries and every card-state-only action work. This matches the card's wording.
- Docs that still name `src/instrumentation.ts` as the boot/tick site: `docs/ARCHITECTURE.md:220`, `docs/IMPROVEMENT_RUNS.md:138`, `docs/SANDBOXING.md:392` and `:472`; the README make-target table has no rows for `worker`, `build-worker`, `check-split`. I will reconcile these on approve if the loop does not.

```findings
[
  { "severity": "critical", "file": "src/server/splitProcesses.test.ts", "line": 75, "issue": "`make lint` fails with @typescript-eslint/no-explicit-any on the api() helper's return type, so `make lint` and `make check` exit non-zero." },
  { "severity": "critical", "file": "src/server/splitProcesses.test.ts", "line": 286, "issue": "`let detail: any` is a second no-explicit-any lint error in the same file." },
  { "severity": "important", "file": "src/server/improvementRuns.ts", "line": 217, "issue": "createImprovementRun() always calls driveRun(), so POST /api/improvement-runs on a web-only process runs the improvement driver and its proposer pi session in the web process, and the worker (which only calls resumeImprovementRuns() once at boot) never adopts the run — contradicting the card's 'never constructs a pi session' for the web role." },
  { "severity": "suggestion", "file": "src/instrumentation.ts", "line": 5, "issue": "Criterion `grep -q 'from \"@/server/boot\"'` fails literally because the file uses `await import(\"@/server/boot\")`; intent is met and the dynamic import is the correct Node-only pattern, so no change is required unless literal compliance is wanted." },
  { "severity": "suggestion", "file": "docs/ARCHITECTURE.md", "line": 220, "issue": "Still says the schedule tick runs 'from src/instrumentation.ts'; it now lives in src/server/boot.ts (same staleness in docs/IMPROVEMENT_RUNS.md:138 and docs/SANDBOXING.md:392,472; README's make-target table lacks worker/build-worker/check-split)." },
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "line": 840, "issue": "In a web-only process pauseCard/pauseEpic only mutate the process-local pausedCards set and cancelCard aborts a controller that lives in the worker; deferred by the card to the cross-process-control piece, but the reviewer should know pause is a no-op across processes today." }
]
```
