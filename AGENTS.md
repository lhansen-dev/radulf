# AGENTS.md

Instructions for coding agents working in this repo — including Radulf's own
self-improvement runs (`src/server/improvementRuns.ts`), which check this
codebase out into a worktree and edit it the same way any other contributor
would.

## Never run tools directly — always go through `make`

`node_modules/.bin` (where `next`, `eslint`, `tsc`, `vitest`, `drizzle-kit`
live) is only on `PATH` inside a Make invocation (`Makefile:1-10`). Running
`npx tsc` or a bare `eslint` will not reliably use the project's pinned
tooling. Run `make help` to see every target; the ones you'll use most:

| Command | What it does |
|---|---|
| `make check` | vitest + eslint + tsc --noEmit + production build — **the full gate** |
| `make test` | Unit, component, route, and lifecycle tests (vitest) |
| `make lint` | ESLint |
| `make typecheck` | `tsc --noEmit` |
| `make build` | Production build |
| `make dev` | Start the app at http://localhost:3000 |

Run `make check` before considering any change finished — it's exactly what
CI runs on every push and PR. `make test` alone is not sufficient; the build
step catches type errors the test suite doesn't exercise.

## Project layout

```
src/
├── app/          Next.js App Router routes and UI components
├── server/       Orchestrator, runners, and provider integrations
└── db/           Drizzle schema definitions
drizzle/          Generated SQL migration files
docs/             Guides served by the in-app Docs tab
specs/            Dated, append-only design decision log
benchmarks/       Repeatable loop-performance fixtures and runners
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full pipeline map
(orchestrator → harness → sandbox) and [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md)
for the same pipeline from a user's perspective.

## `docs/` vs `specs/`

- `docs/` is current, user-facing guidance — rewritten to match the present.
- `specs/` is a dated decision log — **never** rewritten to match the present;
  a superseded design stays on disk, and [`docs/DESIGN_HISTORY.md`](docs/DESIGN_HISTORY.md)
  tracks which spec superseded which. Don't treat an old spec as current
  behavior without checking Design History first.

**Docs registry rule:** dropping a new file under `docs/` does not surface it
in the app. It must also be added to the `DOCS` array in
[`src/server/docs.ts`](src/server/docs.ts) — the wiki is curated, not a
directory listing (see that file's own docstring, `src/server/docs.ts:1-27`).
An unregistered doc still resolves for direct links (`resolveDocHref` sends it
to GitHub) but won't appear in the in-app Docs tab.

## Sandbox mode

Agent bash in this repo runs sandboxed by default — Seatbelt (`sandbox-exec`)
on macOS, bubblewrap + seccomp on Linux — see
[`docs/SANDBOXING.md`](docs/SANDBOXING.md). If you're working on Radulf's own
sandbox code (`src/server/sandbox/`) and bash behaves unexpectedly, check
whether containment is doing exactly what it's designed to do before assuming
it's a bug.

## One card, one worktree

Every card gets its own git worktree under `./worktrees` (gitignored, a
sibling of `data/`) and its own branch, `ralph/<slug>-<runId>`
(`src/server/git.ts:76-100`, `createWorktree`). Never assume you share a
working tree with another run — plan/loop/evaluate runs for the *same* card
reuse one worktree across the cycle, but different cards never share one.

## Branches

PRs target `beta`, not `main`. `main` only ever receives a merge from `beta`
at release time — see [`CONTRIBUTING.md`](CONTRIBUTING.md#branches-and-releases)
for the full release flow.

## Everything else

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, the full guideline list,
and how to open a PR. Read it, along with
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), before making any non-trivial
change.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
