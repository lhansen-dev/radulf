# 07 — Definition of Works

No milestones. Build the whole thing, then keep going until this walkthrough
passes for real. Once it does, all further work routes through the board
itself (the backlog below becomes cards).

## The walkthrough (v1 is done when this works)

1. `make install && make dev` on a Mac (Apple Silicon or Intel) with a Claude
   subscription logged in via a one-time `pi login`.
2. Register a repo in Settings; pick a loop provider (Claude subscription is
   the zero-config default; ChatGPT/Codex subscription, oMLX — needs the server
   up with a tool-capable model — and OpenRouter are optional) + loop model;
   pick a planner model (or leave default). Every provider runs through the one
   pi (SDK) harness; they differ only in auth (13).
3. Create a card with a real definition of done. Press **Start** and confirm it
   enters **In Progress**.
4. Watch it: ◔ planning (frontier pi SDK session writes `.ralph/` artifacts) →
   ⚙ looping (one fresh-context pi SDK session per iteration under the
   structural skip-permissions posture — pi has no permission system (13) —
   live transcript in the card) → `.ralph/DONE` → evaluator gate → card lands
   in **In Review**.
5. Read the diff in-app. Reject with feedback → card returns to In Progress
   and the loop addresses the feedback on the same worktree. Approve →
   `--no-ff` merge lands in the target repo, worktree pruned, card → **Done**.
6. Force the ugly paths and confirm they land in **Needs Attention** with a
   usable exit reason and a restart that works: iteration cap, timeout, loop
   provider stopped mid-run (e.g. oMLX), server restart mid-loop, merge
   conflict.
7. Register radulf in radulf and run one self-improvement card through
   the full lifecycle.

## Backlog once it works (cards for Radulf's own board)

1. ~~**PM pass** — the ✨ Propose improvements button.~~ — **shipped**, then
   superseded by the self-driving **Improvement Run** (06).
2. ~~**Provider preflight** — health-check + model check (e.g. oMLX up and
   serving the model) before a loop starts.~~ **shipped** as
   `preflightProvider` on 09's seam.
3. ~~**Metrics** — token/latency per iteration, run-history views.~~
   **shipped**: per-run tokens, iterations and history via `/api/analytics`.
4. ~~**Scheduling** — crons for queue-draining and Improvement Runs, opt-in (06).~~
   — **shipped** as [22-scheduled-work.md](22-scheduled-work.md).
5. **Hosting & auth** — expose at `radulf.example.com` with
   single-password login (08); cluster manifests managed via GitOps.
6. **Polish** — ~~transcript search~~ **shipped**, better stall heuristics,
   ~~card export/import~~ **shipped**, packaging under launchd.
7. **Deferred bets** — pluggable runners (Ollama), ~~GitHub PR mode~~ —
   **shipped** as [15-github-pr-delivery.md](15-github-pr-delivery.md).
   - ~~Codex CLI harness for a ChatGPT-subscription provider~~ — **shipped** as
     the third adapter on 09's seam (see `specs/09-multi-harness.md`).
8. ~~**Mobile-first workspace** — replace horizontal status lanes with the
   attention-ordered Work feed, responsive shell, and touch/keyboard actions
   specified in [10-mobile-first-ui.md](10-mobile-first-ui.md).~~ **shipped** as
   [10-mobile-first-ui.md](10-mobile-first-ui.md).

## Risks to watch

| Risk | Mitigation |
|------|-----------|
| Small/local loop models too weak to finish loops | Planner writes small, concrete steps; stall detection ends hopeless runs early; PROMPT.md quality is the main lever — iterate on the skeleton; the Claude-subscription default sidesteps this entirely |
| Skip-permissions loop misbehaves outside the worktree | Prompt guardrails + disposable worktrees; review diffs before merge; keep loops off repos you can't afford to `git reset` |
| Harness API drift across pi's fast release cadence | Pin the `@earendil-works/pi-coding-agent` npm version; the single SDK runner isolates the surface to one module; rerun the walkthrough + spec 13 checklist after upgrades |
| oMLX upgrades change its API surface | 09's verification checklist; preflight check (backlog #2) |
| Dev-server hot reload duplicating the orchestrator | Global-singleton guard in instrumentation.ts |
| Worktree litter after crashes | Boot recovery marks `interrupted` and lists orphaned worktrees in Settings for cleanup |
