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

## Branches and releases

Two long-lived branches:

| Branch | What it is |
|--------|------------|
| `main` | Stable. Only ever receives a merge from `beta` at release time, so between releases it sits exactly at the last stable tag. This is what a plain `git clone` gets. |
| `beta` | Integration. All work lands here first. **Open your PR against `beta`, not `main`.** |

Releases are git tags; the [Release workflow](.github/workflows/release.yml) runs
`make check` and publishes a GitHub Release from the tag. Tags with a hyphen
(`v1.1.0-beta.1`) are SemVer prereleases and are published as such, so they never
displace the current stable release as "Latest".

```bash
# Cut a beta off the integration branch
git switch beta
make release VERSION=1.1.0-beta.1

# Promote to stable once it's proven
git switch main && git merge --ff-only beta
make release VERSION=1.1.0
git switch beta && git merge main   # carry the version bump back
```

`--ff-only` is deliberate: it fails loudly if anything was committed directly to
`main`, which is what keeps the branch honest. `make release` refuses to tag a
stable version from anywhere but `main`, or a prerelease from anywhere but `beta`.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>): <subject>
```

`feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore` — see
the table in [`AGENTS.md`](AGENTS.md#commit-messages) for which is which, plus
the footer conventions agents use. The subject is imperative and lowercase
(`fix: reject repos with no commits`), the first line stays under 72
characters, and the reasoning goes in the body.

Two things worth knowing before your first PR:

- A breaking change takes a `!` before the colon (`feat(db)!: …`) and a
  `BREAKING CHANGE:` footer. That footer is what surfaces it in the release
  notes when `beta` is promoted to `main`.
- When a commit implements a spec, name it — `feat: deliver an approved diff as
  a GitHub pull request (spec 15)`. The spec itself lands first, as its own
  `docs:` commit.

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
  [Architecture](docs/ARCHITECTURE.md) for where things live in the tree, and
  [How it works](docs/HOW_IT_WORKS.md) for the shape of the pipeline. Reach for
  [`specs/`](specs/00-overview.md) when you want the *why* behind a decision —
  checking [Design history](docs/DESIGN_HISTORY.md) first, since several specs
  are superseded and describe designs that no longer ship.

## Reporting bugs and requesting features

Open a [GitHub issue](https://github.com/lhansen-dev/radulf/issues). For security
issues, follow [SECURITY.md](SECURITY.md) instead of filing a public issue.
