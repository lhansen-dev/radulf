# 05 — UI Design

> **Presentation amended 2026-07-12:** [10-mobile-first-ui.md](10-mobile-first-ui.md)
> is the canonical target for navigation, the Work screen, responsive behavior,
> and interaction design. The horizontal board below documents the currently
> implemented UI and remains useful for its lifecycle/API details; it is not the
> target layout for future frontend work.

Dark-mode-first, dense but calm. The board is the home screen; everything else
is a slide-over or a full-page detail reached from a card. Tailwind, @dnd-kit,
no component framework (agents modify this UI — fewer abstractions, fewer
surprises).

## Screens

### Board (`/`)

```
┌ Radulf ──── [Repo filter ▾] [+ New card] [••• ▾ Start improvement run] [📊 Analytics] [⚙] ─┐
│                                                                                │
│ Backlog      Todo         In Progress       In Review      Needs ⚠      Done   │
│ ┌────────┐   ┌─────────────┐    ┌──────────┐    ┌───────────┐   ┌──────────┐   │
│ │card    │   │card         │    │card      │    │card       │   │card    ✓ │   │
│ │        │   │ ⚙ iter 7/20 │    │ +214 −32 │    │ stalled   │   └──────────┘   │
│ └────────┘   │ ▂▄▆ live    │    └──────────┘    └───────────┘   ┌──────────┐   │
│ ┌────────┐   └─────────────┘                                    │card    ✓ │   │
│ │card 🤖 │   ┌─────────────┐                                    └──────────┘   │
│ └────────┘   │card ◔ plan  │                                                   │
│              └─────────────┘                                                   │
└────────────────────────────────────────────────────────────────────────────────┘
```

- Cards show: title, source badge (🤖 for agent-proposed), a wrapping row of
  tags (repo chip, resolved planner model, resolved implementing model, and
  resolved evaluator model — shown
  in full without truncation, wrapping to additional lines when they don't
  fit), and a sub-state line. Resolved model tags are computed server-side in
  `GET /api/cards`: a model served by the Anthropic (Claude subscription)
  provider is prefixed `claude-subscription/` (e.g. `claude-subscription/opus`),
  while oMLX / OpenRouter models are shown raw; an empty/null model resolves to
  `null` and the chip renders "default". The four chips have distinct colours
  — repo = slate, planner = sky, loop (implementer) = violet, evaluator = amber — so roles are
  distinguishable at a glance. In Progress cards surface where the pipeline is: ◔
  planning, ⏳ queued for a loop slot, ⚙ `iter n/max` with live activity, 🔎
  evaluating after DONE, and ⏸ paused (after a user pause; the card stays in
  In Progress until resumed).
  In Review shows the diff stat; Needs Attention shows the exit reason.
- The orchestrator moves cards between sections as it works; state controls are
  only meaningful where humans have agency: Backlog→Todo (schedule), reorder
  within Todo, Todo→In Progress (start now), Needs Attention→In Progress
  (restart after fixing things up), and Todo/In Progress (including
  `paused`)/In Review/Needs Attention→Backlog (pull it back, cancelling active
  runs / clearing a pause after a confirm). All other transitions reject.
- Board updates live via a single SSE connection (`/api/events/stream`) —
  server pushes event rows, client refetches affected cards.
- **Start improvement run** opens a dialog (repo, base branch, optional focus
  prompt, time budget, optional model/reasoning/iteration/timeout overrides);
  submitting it `POST`s `/api/improvement-runs`. A running Improvement Run
  appears as a live row in the Active section — feature branch, countdown to
  the run's deadline, tasks succeeded, and the in-flight card's title — kept
  current via the SSE stream and `GET /api/improvement-runs`, with a **Stop**
  button that soft-stops between tasks. The row disappears when the run ends,
  and a dismissible banner (or a browser notification, if enabled) then names
  the feature branch and the number of tasks landed.
- When a self-merged card lands a DB migration under the running dev server
  (hot reload swaps in schema code the open connection never migrated for),
  the board shows an amber **restart required** banner. Clicking it confirms,
  cancels any In Progress cards back to Backlog, and restarts the server via
  `POST /api/restart`; the board polls `/api/health` and reloads when it's
  back.

### Card detail (slide-over, `/card/[id]`)

Tabs: **Overview** (description, repo, plan version history, caps override),
**Plan** (PLAN.md / PROMPT.md / CRITERIA.md rendered, editable while the card
is in Backlog, Todo, or Needs Attention), **Activity** (event feed + per-iteration list,
rendered oldest → newest top-down — the API returns the latest 100 events
reversed to ascending id order; clicking an iteration opens its transcript).
For each loop run the Activity tab also renders a `MetricsPanel` table with
per-iteration **Iter / Duration / Prompt / Completion** columns and a **Total**
row; while a run is `running`, the Total row and any in-progress iteration row
update their elapsed duration in real time (once per second) instead of showing
a placeholder dash until the run finishes.
**Transcript** (live tail while
looping — rendered from stream-json: assistant text, tool calls collapsed to
one-liners, expandable). Each collapsed tool call shows a short
human-readable description next to the tool name (e.g. the command for Bash,
the file path for Read/Edit/Write, the pattern for Grep/Glob) so the transcript
is scannable without expanding every entry). The Plan tab and the
plan-review state's "Generated plan" block also render a `PlanModelBadge`
("Planned by: <tag>") derived from the most recent `plan` run's resolved
provider/model, so it's obvious which model authored the plan.

### Review (`/review/[cardId]`, full page)

- Header: card title, the loop's DONE summary (rendered as formatted
  markdown — headings, paragraphs, unordered/ordered lists, and inline
  **bold**, *italic*, `code`, and [links](url)), iteration count, total
  wall time.
- Directly below the DONE summary: the evaluator verdict and its verification
  note. Approvals use a positive treatment; revision-limit escalations use an
  amber treatment and keep the unresolved feedback visible to the human.
- Main: file-by-file diff (server-parsed `git diff`), collapsible per file,
  syntax highlighted, `.ralph/` excluded.
- Side rail: PLAN.md, CRITERIA.md (the evaluator's verification checklist), and the
  final iteration summary. A `PlanModelBadge` ("Planned by: <tag>") sits above
  the CRITERIA.md `<details>`, surfaced from the most recent `plan` run's
  resolved provider/model so reviewers can see which model authored the plan.
- Footer actions: **Approve & merge** (primary), **Reject with feedback**
  (opens required-textarea modal), **Abandon** (danger, confirm).

### Analytics (`/analytics`)

A read-only metrics dashboard reached from the board header's "📊 Analytics"
link. Fetches `GET /api/analytics` (a pure `computeAnalytics` rollup of cards,
runs, and iterations) and renders:

- **KPI tiles** — Cards, Runs, Iterations, Total Tokens (prompt + completion).
- **Charts** — Cards by Status and Runs by Status (horizontal `BarList`, sorted
  desc), Tokens per Run (bar per run labeled by card title, zero-token runs
  filtered, sorted desc), and a Success Rate meter
  (`completed / (completed+failed+timeout+cancelled+interrupted)`).

Shows loading, error, and empty (no cards yet) states. No mutations — purely a
view over existing data.

### Settings (`/settings`)

Repos CRUD (path picker validates it's a git repo), provider + model pickers
per role (planner / loop / evaluator — no summarizer role, spec 14; providers are Anthropic subscription —
the default, nothing to configure — ChatGPT/Codex subscription, OpenRouter, or
oMLX; model pickers are fed by `GET /api/providers/[provider]/models`). Each
role also has a **reasoning level** picker (pi thinking level, default Medium;
applies across every provider — see 13). There is no fallback provider — a
provider failure lands the card in Needs Attention (04).
Optional provider credentials
(oMLX base URL + API key, OpenRouter API key — only needed if you pick those
providers), **appearance** (theme picker — Default, Default Light, Solarized Dark,
Solarized Light, Tokyo Night, Tokyo Day, Nord, Nord Light, Gruvbox Dark,
Gruvbox Light; persisted in settings and applied to `<html
data-theme="...">`), notifications & sounds (optional browser notification and
alert sound when a card moves to In Review or Needs Attention, plus a test
button), loop defaults (max iterations, timeout), orphaned-worktree cleanup
list, and editable prompt templates for planning artifacts, evaluation,
summarization, and self-improvement proposals. The template editors document
supported placeholders and can restore all versioned built-in defaults.

## API surface (route handlers)

```
GET/POST        /api/repos            GET/PATCH/DELETE /api/repos/[id]
GET/POST        /api/cards            GET/PATCH/DELETE /api/cards/[id]
POST            /api/cards/[id]/move          {status, position} — queue/start/reorder/pull back
POST            /api/cards/[id]/restart       Needs Attention → re-enter the loop queue
POST            /api/cards/[id]/pause         looping → paused (after current iteration finishes)
POST            /api/cards/[id]/resume        paused → ready (reuses worktree + PLAN.md, may run with edited model overrides)
GET             /api/cards/[id]/diff
POST/GET        /api/improvement-runs         POST creates+starts a run, GET lists active/recent runs
POST            /api/improvement-runs/[id]/stop   soft-stop between tasks
POST            /api/reviews                  {runId, decision, feedback}
GET             /api/runs/[id]                (+ ?iteration=N transcript page)
GET             /api/runs/[id]/stream         SSE live transcript
GET             /api/events/stream            SSE board updates
GET/PATCH       /api/settings
GET             /api/providers/[provider]/models   model list per provider (CLI / oMLX / OpenRouter)
GET             /api/health                   liveness + restartRequired (pending migrations)
POST            /api/restart                  cancel In Progress cards, exit for dev respawn
GET             /api/analytics                metrics rollup (totals, by-status, tokens/run, durations, success rate)
```

Mutations validate lifecycle invariants (03) server-side; the board never
trusts a drag.

## Visual language

- Theming: the shell exposes its palette as CSS variables
  (`--background`, `--foreground`, `--accent`, `--accent-strong`,
  `--on-accent`, `--surface`), overridden per theme by `[data-theme="..."]`
  blocks on `<html>`. The current theme is read from persisted settings
  (`theme`, default `"default"`) and rendered server-side on the layout.
  Built-in themes: Default, Default Light, Solarized Dark, Solarized Light,
  Tokyo Night, Tokyo Day, Nord, Nord Light, Gruvbox Dark, Gruvbox Light.
  **Components MUST consume the palette via the theme-token Tailwind
  utilities** (`text-foreground`/`bg-foreground`/`border-foreground`, with
  opacity modifiers preserved, e.g. `text-foreground/70`), `text-on-accent`
  for text sitting on an amber accent button, and `bg-surface` for elevated
  panels and menus — never hardcoded `text-white`/`bg-white`/`border-white`/
  `text-black` or literal dark-hex backgrounds (`bg-[#181c21]`, …). Those
  hardcoded utilities ignore the theme variables, which is what previously
  broke light/alternate themes (text stayed white and invisible on a light
  background). `bg-black/60` and `bg-black/70` modal backdrops are the only
  intentional literal colors; amber/red/green/violet are mapped to the accent
  or kept as brand colors.
- Section accent colors: Backlog neutral, Todo slate, In Progress amber (animated pulse on the
  actively-looping card), In Review violet, Needs Attention red, Done green.
- Typography: system sans; transcripts and diffs in a monospace stack.
- Empty states teach the flow ("Register a repo → write a card → add it to
  Todo").
- Every long-running state shows elapsed time; never a bare spinner.
