# AGENTS.md

Instructions for coding agents working in this repo — including Radulf's own
self-improvement runs (`src/server/improvementRuns.ts`), which check this
codebase out into a worktree and edit it the same way any other contributor
would.

## How to work

Adapted from [Andrej Karpathy's agent guidelines](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md).
They bias toward caution over speed — for trivial tasks, use judgment.

### 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing.

Radulf's own runs have no human to ask mid-run. There, pick the most
conservative reading of the card, and write down the assumption and the
alternatives you rejected in the commit body so the reviewer sees them.

### 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes,
simplify.

### 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports, variables, and functions that *your* change made unused;
  leave pre-existing dead code alone unless asked.

The test: every changed line should trace directly to the request. This is the
same rule as "one logical change per commit" below, applied line by line.

### 4. Goal-driven execution

**Define success criteria. Loop until verified.**

Turn tasks into verifiable goals:

- "Add validation" → write tests for invalid inputs, then make them pass.
- "Fix the bug" → write a test that reproduces it, then make it pass.
- "Refactor X" → `make check` passes before and after.

For multi-step tasks, state a brief plan with a check for each step:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

Strong success criteria let you loop independently; "make it work" doesn't.
Whatever the per-step checks, the final one is always `make check`.

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

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>): <subject>

<optional body>

<optional footers>
```

The types in use here:

| Type | Use it for |
|---|---|
| `feat` | New user-visible behavior |
| `fix` | A bug fix |
| `docs` | `docs/`, `specs/`, `README.md`, this file |
| `refactor` | Restructuring with no behavior change |
| `test` | Tests only |
| `perf` | A change made for speed, with a measurement behind it |
| `build` | Dependencies, `Makefile`, `next.config.ts`, migrations tooling |
| `ci` | `.github/workflows/`, Dependabot |
| `chore` | Anything else that touches no product code |

Rules for the subject line:

- Imperative mood, lowercase, no trailing period — `fix: reject repos with no commits`, not `Fixed repos…`.
- Keep the whole first line under 72 characters; put the reasoning in the body.
- Scope is optional and, when used, names an area of the tree rather than a
  file — `orchestrator`, `sandbox`, `docs`, `db`, `ui`.

Breaking changes take a `!` before the colon (`feat(db)!: …`) **and** a
`BREAKING CHANGE:` footer explaining the migration. Since `main` only receives
merges from `beta` at release time, a breaking change lands on `beta` like any
other commit — the footer is what makes it visible in the release notes.

Repo-specific footers and conventions:

- Reference a spec by number when a commit implements one — `feat: deliver an
  approved diff as a GitHub pull request (spec 15)`. Adding the spec itself is
  a separate `docs:` commit that lands first.
- Agents (including self-improvement runs) keep their `Co-Authored-By:` and
  session trailers in the footer block, after any `BREAKING CHANGE:`.
- The `nextjs-agent-rules` block that `next dev` rewrites into this file is
  committed alongside whatever work you were doing — it does not need its own
  commit.

One logical change per commit. If `make check` only passes with two unrelated
fixes in the tree, that's two commits.

## Always commit your changes

Commit finished work before you hand it back — don't leave changes sitting
uncommitted in the working tree for someone else to pick up. The only exception
is when the user explicitly asks you not to commit.

- Commit once `make check` passes, following the message format above.
- Split unrelated changes into separate commits rather than skipping the commit.
- Committing is not pushing: don't push or open a PR unless asked.
- Radulf's own loop runs are the exception by design — there the orchestrator
  makes every commit, and the loop prompt forbids the agent from running git
  commands that change state. Follow the prompt.

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
