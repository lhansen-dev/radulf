# Contributing to Radulf

Thanks for your interest in Radulf. This is a small, single-maintainer project;
contributions are welcome, and the bar is simply that changes are clear, tested,
and keep the existing checks green.

## Getting set up

Requirements: macOS (Apple Silicon or Intel) and Node 22+.

```bash
git clone https://github.com/lhansen-dev/radulf.git
cd radulf
make install
make login         # opens pi — type /login to authenticate a provider
make dev           # http://localhost:3000
```

All common tasks are driven through the [`Makefile`](Makefile) — run `make` to
see the full list. It is the source of truth; CI and the release workflow call
the same targets you do.

The SQLite database and runtime directories are created automatically on first
run under `./data` (gitignored), alongside `./worktrees`, `./plans` and
`./runtmp` — all four are ignored. No manual migration step is needed. To
exercise the full pipeline you also need at least one agent provider configured;
see [Providers and models](docs/PROVIDERS.md) for what `make login` does and why
running `pi` yourself authenticates the wrong directory.

## Project layout

```
radulf/
├── src/
│   ├── app/          Next.js App Router routes and UI components
│   ├── server/       Orchestrator, runners, and provider integrations
│   └── db/           Drizzle schema definitions
├── drizzle/          Generated SQL migration files
├── docs/             The guides served by the in-app Docs tab
├── specs/            Dated design decision log — see docs/DESIGN_HISTORY.md
├── benchmarks/       Repeatable loop-performance fixtures and runners
└── data/             Gitignored runtime state (SQLite DB, worktrees, transcripts)
```

The one non-obvious rule: `docs/` is what users read, `specs/` is the record of
what was decided and when. A spec is never rewritten to match the present — if a
decision changes, a later spec supersedes it and
[`docs/DESIGN_HISTORY.md`](docs/DESIGN_HISTORY.md) tracks which. User-facing
behavior changes belong in `docs/`.

Everything registered in the Docs tab lives in
[`src/server/docs.ts`](src/server/docs.ts). The wiki is curated, so adding a file
under `docs/` does not surface it — add a registry entry too.

## Before you open a PR

Run the full gate locally — this is exactly what CI runs on every push and PR:

```bash
make check         # vitest + eslint + tsc --noEmit + production build
```

Individual pieces, if you want faster feedback:

| Command | What it does |
|---------|--------------|
| `make test` | Unit, component, route, and lifecycle tests (vitest) |
| `make lint` | ESLint |
| `make typecheck` | `tsc --noEmit` |
| `make build` | Production build |

## Guidelines

- **Keep the diff focused.** One logical change per PR; unrelated cleanups in
  their own PR.
- **Add or update tests** for behavior you change. The suite covers the
  orchestrator lifecycle, API routes, and components — follow the nearest
  existing pattern.
- **Match the surrounding code.** Naming, structure, and comment density should
  read like the file you're editing.
- **Prefer one code path.** When a change supersedes an old approach, remove the
  old one rather than leaving both behind a flag. Fail loudly over silently
  falling back.
- **Read the design docs first** for anything non-trivial. Start with
  [How it works](docs/HOW_IT_WORKS.md) for the current shape of the pipeline,
  then [`specs/`](specs/00-overview.md) for the architecture and data model —
  checking [Design history](docs/DESIGN_HISTORY.md) first, since several specs
  are superseded and describe designs that no longer ship.

## Reporting bugs and requesting features

Open a [GitHub issue](https://github.com/lhansen-dev/radulf/issues). For security
issues, follow [SECURITY.md](SECURITY.md) instead of filing a public issue.
