---
name: verify
description: Verify a radulf change by driving the running app — launch/restart recipe, API surface, and screenshot capture for this repo.
---

# Verifying radulf changes

Next.js (App Router) + better-sqlite3 at `$RADULF_DATA_DIR/radulf.db` (drizzle
migrations run at first DB touch per process). UI is client-rendered; verify
via the JSON API plus a headless-Chrome screenshot of the page.

## Launch / restart

- The user usually already runs `make dev` on **port 3000** (there is no
  `npm run dev` script — the Makefile is the only entry point); Next's dev
  lock refuses a second instance for this app dir, so don't try to start
  your own on another port.
- The running server keeps one DB connection per process (`globalThis`), so
  a **new migration is not applied until restart** — new-column queries 500
  with "no such column" until then. Sanctioned restart:
  `curl -X POST http://localhost:3000/api/restart` (dev CLI respawns the
  child; it first cancels In Progress cards back to Todo — check
  `select status, count(*) from cards group by status` first and avoid
  restarting while cards are looping).
- **Hot reload does not reach the orchestrator.** It is a `globalThis`
  singleton built at boot, so after editing server code a run reaches
  (`src/server/**`: providers, harness, stage services), pipeline runs keep
  executing the *old* modules while routes serve the new ones. Seen live: a
  just-added provider id failed `isProviderId` inside the stale orchestrator
  and `normalizeProvider` fell back to `anthropic`. `POST /api/restart`
  (after the in-progress check above) before driving a run, and confirm the
  `next-server` PID changed — health answers `ok` from the old process too.
- **Don't `kill` the `next-server` child by hand** as a restart shortcut —
  the signal takes the whole `make dev` → `next dev` chain down with it and
  kills the user's foreground terminal, rather than being respawned. Use
  `/api/restart`; if the server is too broken to serve it, ask the user to
  restart their own terminal.
- `make build` writes into the **same `.next`** the dev server is serving
  from and leaves it 500ing on every route. Don't run it against a live dev
  server without warning the user; recovery is `rm -rf .next` plus a real
  dev-server restart. To run the build step of `make check` alongside a live
  server, build a copy instead: `rsync` the tree (minus `node_modules`,
  `.next`, `.git`, `.env.local`) into scratch, clone `node_modules` with
  `cp -cR` (APFS copy-on-write, ~8s; Turbopack rejects a symlinked
  `node_modules`), then `NODE_ENV=production node_modules/.bin/next build`.
- The DB is at `$RADULF_DATA_DIR/radulf.db`, **not** `data/radulf.db` —
  `.env.local` points `RADULF_DATA_DIR` outside the repo so the dev watcher
  doesn't see WAL churn. Read the env file before reaching for sqlite. A
  **0-byte `data/radulf.db` is still sitting in the repo** from before that
  override; sqlite opens it happily and reports an empty schema rather than an
  error, so a wrong path looks like a wiped database. Same for
  `$RADULF_DATA_DIR/worktrees` vs `data/worktrees`.
- Auth middleware is a no-op unless `RADULF_AUTH_PASSWORD_HASH` is set —
  locally you can hit everything without a session.
- Before launching/restarting anything, confirm `autoMode` is `false` in the
  `settings` table — otherwise boot may auto-start a Todo card and spawn a
  real agent run.

## Drive

- Health: `GET /api/health`. Analytics: `GET /api/analytics` (filters:
  `?range=today|7d|30d&provider=&model=`).
- Page screenshot (no Playwright in this repo; use installed Chrome):
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --disable-gpu --window-size=1280,1600 \
    --virtual-time-budget=8000 --screenshot=out.png \
    http://localhost:3000/analytics`
- **Against `next dev`, that command can hang forever on any page** — the HMR
  WebSocket (plus the SSE stream on `/` and `/card/<id>`) is a connection that
  never closes, so `--virtual-time-budget` never expires and no PNG is ever
  written. A fresh `--user-data-dir` does not help. Either screenshot a
  production server (`make build && make start`), or wrap the call so you can
  reclaim it — macOS has no `timeout(1)` by default, so use
  `run_in_background` and `pkill -f "Google Chrome.*headless"`, and treat "no
  PNG" as expected rather than a bug in your change. For run/card state, the
  JSON API (`GET /api/cards`, `GET /api/improvement-runs`) is faster and
  actually terminates.
- Migration dry-run without touching the real DB:
  `sqlite3 "$RADULF_DATA_DIR/radulf.db" ".backup $SCRATCH/copy.db"` then run
  drizzle `migrate()` against the copy via a `node -e` snippet. Check the copy
  is non-empty before trusting the result — see the DB-path note above.

## Gotchas

- `$RADULF_DATA_DIR/worktrees/**` contains stale checkouts that break a bare
  `npx tsc --noEmit` (missing `@testing-library/*` types) — pre-existing,
  not your change. Most are orphaned: `git worktree list` no longer knows
  about them, so `git worktree prune` won't clear them and only `rm -rf` will.
- A full live loop run (orchestrator → harness → LLM) spends real tokens and
  creates worktrees/commits. **Never start one silently — ask first** (see
  [Spending real credits](#spending-real-credits)). For routine verification,
  drive the pipeline with the [mock provider](#free-pipeline-runs-the-mock-provider)
  instead.

## Free pipeline runs: the mock provider

The `mock` provider (`src/server/harness/mock.ts`) replaces only the model:
scripted replies, real tool execution, so a card goes planner → loop →
evaluator → In Review in seconds with worktrees, commits, transcripts,
telemetry, and SSE all real. **This is the default way to see a pipeline
change work**, and it spends nothing.

- **Headless first:** `src/server/mockPipeline.test.ts` drives every scenario
  through the real orchestrator against a temp repo + DB. Run it with
  `node_modules/.bin/vitest run src/server/mockPipeline.test.ts` (~5s). Add a
  case there when a change affects the pipeline's shape. Often that is all
  the verification a change needs.
- **Live server:** needs `RADULF_MOCK_LLM=1` in the server's env. Check
  `.env.local`; if it's missing, ask the user to add it (a Next dev server
  reloads env files on change). Without the flag a `mock` run fails with
  "the mock provider is disabled". It never falls back to a paid provider.
- Select it per role via
  `curl -X PATCH localhost:3000/api/settings -H 'content-type: application/json' -d '{"plannerProvider":"mock","loopProvider":"mock","evaluatorProvider":"mock","plannerModel":"","loopModel":"","evaluatorModel":""}'`.
  **Record the previous provider/model values first and restore them when
  done** — these are the user's real settings.
- The model id picks the scenario: `happy-path` (blank), `revise-once`,
  `planner-questions`, `provider-error`, `stuck`, `phantom`, `stall` (≥30s,
  the stall-watchdog floor). A card's per-role model fields
  (`plannerModel`/`loopModel`/`evaluatorModel`) steer one card to a scenario.
- Then create a card on a throwaway repo, start it, and watch
  `GET /api/cards/<id>` (runs included) until it settles. The repo still gets
  real worktrees and branches, but it's local and free.
- What it can't verify: prompt quality or real-provider behavior (auth,
  catalogs, streaming quirks). Those still need a real run, and that means
  asking first.

## Spending real credits

Anything that reaches a provider — starting a card, an Improvement Run, a
planner chat — bills the user's real account and writes real commits. Before
driving any of those:

**Ask the user whether to spend real credits**, and say what it will cost them
in rough terms — which pipeline stages will run, roughly how long, and what it
will leave behind (a branch, worktrees, `needs_attention` cards). Offer the
no-spend alternative in the same breath: unit tests or the
[mock provider](#free-pipeline-runs-the-mock-provider) usually prove the same
plumbing for free. Use `AskUserQuestion` so it's one click.

If they decline, or if there's no one to ask (an unattended/scheduled run), do
the free verification instead and say plainly which parts stayed unverified —
never quietly substitute a mock for a live run the user asked for, and never
quietly upgrade a mock into a live run.

Once they approve, keep the blast radius small: the tightest **Focus** prompt
that still exercises the path, a low iteration cap, the shortest budget that
can realistically finish one card, and a throwaway base branch. Approval covers
the run you described — a second run, or a much bigger one, is a new question.
