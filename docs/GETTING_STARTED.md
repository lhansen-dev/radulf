# Getting started

This page takes you from a fresh clone to a merged card.

## What you need

| What | Detail |
|------|--------|
| **OS** | macOS (Apple Silicon or Intel). Linux (including WSL2) is best-effort: the sandbox has a Linux implementation, but it is not release-verified. Native Windows and WSL1 are not supported. |
| **Node** | 22 or newer. |
| **A provider** | At least one. See [Providers and models](PROVIDERS.md). |

Everything else is a pinned dependency — including the pi SDK and the sandbox
runtime — so there are no global installs and no CLIs to manage.

## Install and run

```bash
git clone https://github.com/lhansen-dev/radulf.git
cd radulf
make install
make dev
```

Then open <http://localhost:3000>.

The SQLite database and every runtime directory are created for you on first run
— `./data`, plus `./worktrees`, `./plans` and `./runtmp` beside it, all
gitignored. There is no migration step to remember.

All tasks run through the [`Makefile`](../Makefile) — run `make` on its own for
the full list. It is the single source of truth, and CI calls the same targets.

## Log in a provider

Radulf needs at least one provider before it can run anything. For the
subscription providers (Claude, ChatGPT, GitHub Copilot) this is a one-time
interactive login pointed at Radulf's own agent directory:

```bash
make login
```

That opens pi. Type **`/login`** inside it — it is a command in pi's own UI, not
a shell command — pick your provider, follow the OAuth prompts, and quit with
`Ctrl+C` once it reports success.

Use the `make login` target rather than running `pi` yourself; if you want to
know why, [Providers and models](PROVIDERS.md#the-five-providers) explains where
the credential lands and what goes wrong otherwise.

OpenRouter and a local server need no login at all — set an API key or a base URL on the
**Settings → Providers & keys** page instead. The full matrix is in
[Providers and models](PROVIDERS.md).

## Your first card

1. **Register a repo.** Open **Settings → Repositories → Add repository**, or
   pick **Add a repository…** in the repository dropdown when creating a task.
   Browse to the folder (entries carrying a `.git` are marked, and offer
   **Select** directly), or type an absolute path. Set the default branch, or
   leave it blank to auto-detect. Radulf never writes to this checkout except
   when merging an approved card.

   Starting from nothing? Browse to the parent folder, type a name under
   **New repository name** and choose **Create here**. Radulf runs `git init`
   on `main`, adds a README with an initial commit, and registers the result.

   Browsing is confined to one directory, your home directory unless
   **Settings → Repositories → Browsable root** says otherwise. A repo kept
   outside that root is still reachable by typing its path.
2. **Write a card.** A title, and a description that states the definition of
   done. Be concrete about what "finished" means — the evaluator will hold the
   loop to exactly that. The card lands in **Backlog**, where nothing will start
   it.
3. **Move it to Todo.** This is the ordered execution queue. With Auto Mode on
   (the default) the card starts when its turn arrives; **Start now** claims the
   slot immediately.
4. **Watch it work.** The card shows its live sub-state as it plans, loops, and
   is evaluated, along with the iteration count, the current transcript, and the
   files it has touched.
5. **Review the diff.** When the evaluator clears the change the card lands in
   **In Review** with the diff and the transcript. **Approve** merges it into
   the repo's default branch and moves the card to **Done**; **Reject** sends
   the card back to the planner with your feedback for another pass.

For what happens between steps 4 and 5, see [How it works](HOW_IT_WORKS.md).

## Good first cards

The pipeline rewards a card whose success is checkable by running something.
"Fix the failing test in `parser.test.ts`" gives the evaluator an unambiguous
criterion; "clean up the parser" does not, and tends to come back either
over-scoped or trivially satisfied.

Start on a repo you would be comfortable throwing a branch away from.

## If something gets stuck

A loop that hits its iteration cap or timeout, or errors repeatedly, moves the
card to **Needs Attention** with the exit reason, the transcript, and a summary
of where it got to. From there you can edit the card or its plan and restart it,
send it back to Backlog, or abandon it.

Two caps bound every loop run, both overridable per card: a maximum iteration
count (default 50) and a wall-clock timeout (default 60 minutes).

For what a specific exit reason means, [Troubleshooting](TROUBLESHOOTING.md) is
keyed on the strings Radulf actually prints.

## Next steps

- [Improvement Runs](IMPROVEMENT_RUNS.md) — hand a repo a time budget and let
  Radulf write the cards itself.
- [Authentication](AUTHENTICATION.md) — required if you expose Radulf beyond
  localhost.
- [Sandboxing](SANDBOXING.md) — how agent runs are contained, and the disk-limit
  options for operators who want a hard ceiling.
- [Troubleshooting](TROUBLESHOOTING.md) — every exit reason and error string,
  and what to do about it.
