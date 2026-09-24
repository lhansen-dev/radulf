VERDICT: approve

## What I verified

Environment note: the inherited `TMPDIR=/tmp/claude` does not exist and `/tmp` is
read-only, so vitest cannot even start with it. I did not point a temp dir at the
worktree; I used a subdirectory of the run's own private tmp mount
(`/var/lib/radulf/runtmp/<run>/tmp/eval`) for the commands that need one.

### Lint / typecheck (blocker 1)
- `npx eslint src/server/splitProcesses.test.ts` → exit 0.
- `! grep -nE ': any\b|as any\b' src/server/splitProcesses.test.ts` → no matches.
- `make lint` → exit 0. `make typecheck` → exit 0.

### Web-only never drives improvement runs (blocker 2)
- Both greps on `src/server/improvementRuns.ts` (`import { hasRole } from "./roles"`,
  `if (hasRole("worker")) void driveRun(row.id)`) succeed.
- `npx vitest run src/server/improvementRuns.test.ts` → 17 passed. With
  `-t "web-only"` the test `createImprovementRun > does not drive the run in a
  web-only process` runs and passes (1 passed, 16 skipped). Note for whoever
  wrote the criterion: the literal `| grep -q 'web-only'` on the *default*
  reporter fails only because vitest's default reporter prints file-level lines,
  not test names; `--reporter=verbose` shows the name. The intent is met.
- `grep -c 'resumeImprovementRuns()' src/server/boot.ts` → 2 (boot call + pump tick).
- `npx vitest run src/server/boot.test.ts` → 3 passed (asserts ≥3 resume calls
  after 2.5 s at a 1 s interval).

### Previously delivered behaviour
- `roles / orchestrator.roles / boot / migrationLock / authSecret` tests → 23 passed.
- `orchestrator.lifecycle / mockPipeline / improvementRuns` → 126 passed.
- `make build-worker` → exit 0; `dist/worker.mjs` has no `from "next` import
  (externals are node:*, drizzle-orm, better-sqlite3, nanoid, pi, sandbox-runtime).
- No `from "next` anywhere in `src/worker.ts`, `src/server`, `src/db` (non-test).
- `make check-split` → 3 passed in ~5 s: web-only `next dev` + worker-only
  `dist/worker.mjs` on one fresh data dir; `/api/health` reports `roles: ["web"]`,
  `restartRequired: false`; card stays `todo` with `latestRun: null` after the
  move-to-todo; after Start the card reaches `review` with one completed
  plan/loop/evaluate each; web ran without `RADULF_MOCK_LLM` so any stage in web
  would have failed loudly; SIGTERM → `shutdown clean`, exit 0.
- Independently: two `dist/worker.mjs` processes launched in the same instant
  against an empty data dir → one `auth-secret` (0600, 64 hex), 17/17 migrations
  applied, zero duplicate hash rows, no SQLITE_BUSY/EEXIST in either log, neither
  worker holds a listening socket, both drain cleanly on SIGTERM with exit 0.
- `src/server/harness`, `src/server/sandbox`, `Dockerfile`, `compose.yaml`: no
  commit on this branch touches them (`git log beta..HEAD -- <paths>` is empty;
  the diff vs `origin/main` is just `beta` being ahead).

### Docs
- No `src/instrumentation.ts` mention left in `docs/IMPROVEMENT_RUNS.md` or
  `docs/SANDBOXING.md`; exactly one in `docs/ARCHITECTURE.md` (the boot caller).
- README Make-targets table has `make worker`, `make build-worker`,
  `make check-split`, and the updated `make check` description.

### Full gate
- Full `vitest run` once: 1164 passed, 15 failed, all 15 in the environmental
  set the card names (`bookkeeping.test.ts` and the harness `index.test.ts` /
  `streamLiveness.test.ts` stall tests write literal `/tmp`; `srt.test.ts`
  real-runtime rows cannot nest inside the sandbox). Nothing else fails.
- `make build`: `build-worker` runs, then `next build` fails on
  `next/font` fetching Geist from fonts.googleapis.com (403 through the sandbox
  proxy). `src/app/layout.tsx` is unchanged on this branch — pre-existing,
  environmental. So `make check` as a single command cannot pass here, but every
  component that can run in this sandbox passes.

## Things the human reviewer should look at closely

1. **Event fan-out is not part of this piece.** In a genuinely split deployment
   the web process's SSE bus does not see events the worker emits (spec 25
   decision 5, a later card), so the UI will not live-update until then; the
   split check polls the API. The card scopes this out explicitly, but it is
   the main "works but not yet usable" gap.
2. **Scoping turns still run a pi session in a web-only process** — that is spec
   25 decision 9 (named, deliberately kept), not a leak.
3. **`make check` now spawns a real `next dev`** via `check-split`; CI gets a
   120–150 s worst-case timeout on that step.
4. Default topology gains one new behaviour: the 5 s queue-pump timer
   (`RADULF_PUMP_INTERVAL_MS`), which the card asks for. `pump()` is idempotent
   and a no-op while draining.

```findings
[
  { "severity": "suggestion", "file": "src/server/boot.ts", "line": 68, "issue": "The 5 s pump tick calls getSettings() (full settings read + decrypt) on every interval even when the queue is empty; cheap enough today, but a quick 'any todo/ready rows?' pre-check would keep idle workers from decrypting the settings table every five seconds." }
]
```
