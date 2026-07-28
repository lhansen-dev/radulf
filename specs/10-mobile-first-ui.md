# 10 — Mobile-first workspace

This spec replaces the board-shaped presentation in [05-ui-design.md](05-ui-design.md).
Radulf remains kanban-inspired: tasks have ordered workflow states and the
orchestrator advances them. Those states are a model, not a requirement to draw
five or six lanes across the screen.

The new home is an **operations feed**. It answers, in order:

1. What needs me?
2. What is Ralph doing now?
3. What will run next?
4. What changed recently?

This hierarchy works on a phone without hiding the product inside horizontal
scrolling, and it is a better fit for a mostly autonomous pipeline on desktop
too. The user manages exceptions and priority rather than continuously moving
sticky notes.

## Design principles

- **Attention over status.** Reviewable and stuck work is promoted above the
  queue even if it appears later in the lifecycle.
- **Actions over gestures.** Every state change has a labelled button or menu
  item. Drag may enhance desktop queue ordering, but is never the only path.
- **One reading direction.** The primary surface scrolls vertically. Horizontal
  scrolling is reserved for intrinsically wide content such as source diffs.
- **Progress is specific.** Active tasks show phase, elapsed time, iteration,
  and recent activity; never a spinner without context.
- **Details on demand.** Task rows carry enough information to decide what to
  open. Models, full plans, transcripts, and destructive actions live in task
  detail.
- **Touch is first-class.** Controls have at least a 44 × 44 CSS-pixel hit area,
  do not rely on hover, and remain reachable around device safe areas.

## Information architecture

The top-level destinations are:

| Destination | Purpose | Route |
|---|---|---|
| Work | Operational feed and task queue | `/` |
| Activity | Metrics and run history | `/analytics` initially |
| Settings | Repos, agents, appearance, notifications, defaults | `/settings` |
| Info | In-app guide: getting started, card lifecycle, agent roles, providers, project layout | `/info` |

The **Info** reference route (`/info`) renders an in-app guide: Getting
started, the card lifecycle, the four agent roles, provider choices, and the
project layout. It is a primary destination in the shared `AppShell`
(`{ href: "/info", label: "Info", icon: "ℹ" }`, rendered last after Settings),
so it appears as an entry in both the desktop rail and the mobile bottom nav
rather than being reachable only by direct URL.

On narrow screens these are a persistent bottom navigation bar. On wider
screens they appear in a compact left rail. **New task** is the primary action:
a floating button above bottom navigation on narrow screens and a button in the
desktop rail/header. "Start improvement run" and Auto Mode are secondary Work
actions in an overflow menu; their running/enabled state is also visible in a
small automation banner beneath the page title. The overflow menu is built on
the shared `DetailsMenu` component, which closes on any outside pointer click
or `Escape` press (not only on re-clicking the trigger).

The desktop rail (and the rail area on wide screens) ends with an unobtrusive
**GitHub** info link (`rail-repo-link`) that opens
<https://github.com/lhansen-dev/radulf> in a new tab (`rel="noopener noreferrer"`,
`aria-label="Radulf on GitHub"`). It points users at the original repo for
context and provenance without competing with the primary navigation. The
conditional **New task** button and the GitHub link are grouped inside a
`.rail-footer` container pinned to the bottom of the rail with `margin-top: auto`,
so the GitHub link is always the last control in the rail on every page
(Work and non-Work alike), regardless of whether the task button renders.
On narrow screens it stays out of the way of the bottom navigation bar.

Use **Work**, **task**, and **queue** in navigation and instructions. Kanban
status names remain useful labels, but "Board" and "column" are no longer the
names of UI containers.

## Work screen (`/`)

### Default composition

```
Mobile                              Wide
┌ Work ─────────────── [repo ▾] ┐   ┌nav┐ ┌ Work · repo filter ─────── [+ Task]┐
│ [Needs you 2] [Active 1] ...  │   │   │ │ ┌ Needs you ────────────────────┐ │
│                               │   │   │ │ │ Review task             Review│ │
│ NEEDS YOU                   2 │   │   │ │ │ Blocked task               Fix│ │
│ ┌ Review task ────── Review ┐ │   │   │ │ └──────────────────────────────┘ │
│ │ repo · +214 −32 · 8m ago  │ │   │   │ │ ┌ Active now ───────────────────┐ │
│ └───────────────────────────┘ │   │   │ │ │ Loop task · iter 7/20 · 12m   │ │
│ ┌ Blocked task ───────── Fix ┐│   │   │ │ └──────────────────────────────┘ │
│ └───────────────────────────┘ │   │   │ │ Queue (6)                         │
│                               │   │   │ │ ...                               │
│ ACTIVE NOW                  1 │   │   │ └──────────────────────┬────────────┘
│ ┌ Loop task · iter 7/20     ┐ │   │   │                        │context panel│
│ │ latest activity · 12m     │ │   └───┘                        └─────────────┘
│ └───────────────────────────┘ │
│                               │
│ UP NEXT                     6 │
│ 1  Queued task      Start now │
│ 2  Another task             ⋯ │
│                               │
│ BACKLOG                    12 │
│ ○  Unscheduled task    Queue │
│                               │
│             [+]               │
└ [Work] [Activity] [Settings] ┘
```

The default feed contains these sections:

1. **Needs you** — `plan_review`, `review`, and `needs_attention`, sorted by oldest time
   awaiting the user. `plan_review` rows show a **Review** button (opens task
   detail with the plan and an "Approve plan and implement" action); `review`
   rows have a **Review** action; `needs_attention` rows have a **Resolve** action.
2. **Active now** — `planning`, `ready`, `looping`, and `evaluating`, with the currently
   looping task first and queued-for-loop work after it. A row shows the
   human-readable phase, elapsed time, iteration/cap when applicable, and the
   latest meaningful event. For a `looping` card the row additionally shows a
   one-line **Current task** tidbit — the first unchecked `## Tasks` item read
   from the active run's worktree `<worktreePath>/.ralph/PLAN.md` (the same
   checklist the loop ticks off each iteration) — so the user can see *what*
   Ralph is on right now. When no plan file exists or all items are checked it
   falls back to the "Latest activity" line. A running **Improvement Run** also
   surfaces here as a row showing the feature branch, a countdown to the run's
   deadline, tasks succeeded, and the in-flight card's title (or "Proposing
   the next improvement…" while between tasks); it appears via
   `/api/improvement-runs` and is removed when the run ends, at which point a
   completion alert names the branch and the number of tasks landed (see
   [06-self-improvement.md](06-self-improvement.md)).
3. **Up next** — ordered `todo` tasks. This is the only section whose order the
   user manages. Auto Mode (on by default) picks from this queue; each row also
   has **Start now** and an overflow menu. Reordering uses accessible up/down
   controls on touch and keyboard; desktop may additionally support drag handles.
4. **Backlog** — unscheduled `backlog` tasks, newest first. Each row has **Add
   to queue**. Auto Mode never selects from this section.
5. **Recently completed** — the most recent five `done` tasks, collapsed by
   default when there is actionable work. **View all** switches to the Done
   filter.

Empty sections are omitted. If there are no tasks, show one onboarding panel:
register a repo, create a task, then add it to Todo. If filters yield no results,
show a filter-specific empty state and **Clear filters**.

### Scope switcher and filters

The repo switcher sits beside the Work title and applies to every section. Its
label always exposes the current scope (for example, "All repos" or
"radulf"). Remember the selection locally.

A horizontally scrollable chip row filters the feed without changing task
state: **Overview**, **Needs you**, **Active**, **Queue**, **Backlog**, and **Done**. It is a
single-line navigation control, not a set of kanban lanes. Each chip includes a
count, uses `aria-current` when selected, and can be reached by keyboard. The
URL query records repo and view so refresh/back navigation is predictable.

### Task row anatomy

Rows are compact list items, not miniature cards:

- First line: title, agent-proposed marker when relevant, and at most one
  primary action.
- Second line: repo, status/phase, and the most decision-relevant datum (diff
  stat, exit reason, queue position, elapsed time, or completion age).
- Optional third line only for live activity or a two-line exit reason. For
  `looping` cards this third line is the **Current task** tidbit (the first
  unchecked `## Tasks` item from the run's worktree `.ralph/PLAN.md`), falling
  back to "Latest activity" + `exitReason` when the tidbit is unavailable. The
  `/api/cards` payload carries it as `latestRun.currentTask: string | null`.
- Provider/model chips are omitted from the feed. They remain in task detail
  because they rarely change the next action and currently create wrapping
  noise.
- Status is always conveyed by text and icon/shape as well as colour.

Tapping the row opens task detail; tapping its action performs or opens that
specific action and must not also navigate. Destructive actions live in the
overflow menu and require confirmation. Both the task-row overflow menu and
the header Work-actions menu use the `DetailsMenu` component, which dismisses
on an outside click or `Escape` keypress.

### State-changing controls

The visible controls mirror lifecycle invariants:

| Current state | Primary control | Other allowed controls |
|---|---|---|
| Backlog | Add to queue | Edit, delete |
| Todo | Start now | Move up/down, move to backlog, edit, delete |
| Planning | View activity | Move to backlog (confirm if active) |
| Plan review | Approve plan | Move to backlog, view plan |
| Ready / looping | View activity | Move to backlog (confirm if active) |
| Evaluating | View activity | Move to backlog (confirm; aborts evaluator) |
| In Review | Review | Move to backlog, abandon, reset |
| Needs Attention | Resolve | Restart, edit, move to backlog, abandon, reset |
| Done | Open | Delete |

The API remains authoritative and errors are announced inline and through an
`aria-live` region. Optimistic ordering is allowed; lifecycle changes show a
pending state until confirmed.

## Responsive shell

Use content needs rather than device names as the breakpoint rationale:

- **Below 640 px:** one vertical feed, bottom navigation, floating New Task
  action, full-width sheets, 16 px page gutters. Account for
  `env(safe-area-inset-bottom)`.
- **640–1023 px:** one wider feed; bottom navigation may remain. Forms and
  analytics can use two columns when their minimum widths fit.
- **1024 px and above:** 72 px icon/text navigation rail; feed constrained to
  roughly 760 px for readable scan length. Opening a task may use a 400–480 px
  contextual side panel while preserving a shareable full-page route. Review
  stays full-page because diffs benefit from width.

There is no desktop-only source of truth: the same DOM order, labels, actions,
and routes must remain available at every width. Do not use viewport height as
the sole content boundary; browser chrome and virtual keyboards make `100vh`
unreliable. Prefer dynamic viewport units and normal document scrolling.

## Task creation and detail

### New task

New Task opens a bottom sheet on narrow screens and a modal on wide screens.
It has a visible title, close button, focus trap, Escape support, and unsaved
changes confirmation. The form order is title, repo, description/definition of
done, then an **Advanced** disclosure for model/cap overrides, planner chat,
and an unchecked **Review plan before implementation** checkbox. The repo field
defaults to the currently scoped repo (the active **Repo filter**); if no repo
is filtered or the scoped repo is no longer registered, it falls back to the
first registered repo. This prevents new tasks from being silently created in
the wrong repo when a user is viewing a specific repo's scope. When checked,
a successfully generated plan pauses at `plan_review` — the user must approve
the plan from task detail before the loop phase proceeds. The primary submit
action is sticky above the keyboard/safe area on mobile.

### Task detail (`/card/[id]`)

Task detail is a full page on mobile and may be a contextual panel on wide
screens. Its top summary contains title, repo, plain-language status, elapsed
time, and the one primary action for that state. Secondary/destructive actions
move to an overflow menu.

Tabs become a horizontally scrollable tablist: **Overview**, **Plan**,
**Activity**, and **Transcript**. The selected tab is reflected in the URL.
Activity retains chronological order. Live transcript follows output only while
the user is already at the bottom; otherwise it shows a **Jump to latest**
control so new output never steals the reading position.

## Review (`/review/[cardId]`)

Review remains a focused full page:

- Header: task title, DONE summary (rendered markdown: headings,
  paragraphs, lists, inline bold/italic/code/links), iteration count, elapsed
  time, and diff stat.
- Evaluator verdict and note appear before the diff, making the automated gate
  and any revision-limit escalation part of the human review context.
- A file navigator is a sticky side rail on wide screens and a select/sheet on
  narrow screens.
- Each file is collapsible. Diff lines preserve monospace layout and may scroll
  horizontally inside the file only; the whole page must not overflow.
- CRITERIA, PLAN, and final iteration summary are collapsible context sections
  below the diff on mobile and a side rail on wide screens.
- **Approve & merge** and **Reject with feedback** live in a sticky action bar
  above the safe area. Abandon is in overflow, visually separated. Rejection
  uses a full-width mobile sheet with a required textarea.

Approval must never be triggered by a swipe gesture. The merge button states
the consequence, disables while pending, and does not use colour as its only
distinction.

## Activity and settings

Analytics uses a wrapping filter bar, a 2 × 2 KPI grid on narrow screens, and
one chart per row until there is room for two. Charts have textual values and
do not depend on hover tooltips.

Settings is split into linked sections (Repos, Agents, Appearance,
Notifications, Run defaults) on narrow screens and may use a local section
rail on wide screens. The Appearance section exposes the theme picker
(Default, Default Light, Solarized Dark, Solarized Light, Tokyo Night,
Tokyo Day, Nord, Nord Light, Gruvbox Dark, Gruvbox Light), applied to
`<html data-theme="...">` on save.
Labels remain above inputs. Credential/model rows stack rather than squeezing
side by side. Save feedback is persistent long enough for assistive technology
to announce it.

## Visual direction

Retain the dark, calm character, but replace the equal column accents with a
neutral workspace and sparse semantic colour:

- amber = active work;
- violet = ready for review;
- red = blocked/destructive;
- green = completed/success;
- slate = queued/neutral.

Use colour on small status marks, icons, progress tracks, and actions—not as a
full-width lane identity. Prefer subtle separators and tonal surfaces over a
grid of bordered cards. System sans remains the UI face; diffs and transcripts
remain monospace. Motion respects `prefers-reduced-motion`; pulsing live states
must have a non-animated label.

## Accessibility and interaction requirements

- Meet WCAG 2.2 AA contrast for text and controls.
- All functionality works with keyboard and screen reader, including queue
  reordering. After a reorder, announce the new position.
- Focus is visible, returns to the invoking control after a sheet/modal closes,
  and moves to a meaningful heading after route navigation.
- Icon-only actions have accessible names and tooltips where hover exists.
- Dialogs/sheets prevent background interaction and expose name/role/state.
- Loading uses skeletons or labelled progress without replacing already useful
  content. Offline/SSE reconnect state is visible but non-blocking.
- Respect reduced motion and a minimum 44 × 44 px target size.

## Implementation boundary

This is a frontend information-architecture change, not a lifecycle or API
redesign. Existing statuses, SSE events, and mutation endpoints remain valid.
Small API additions are acceptable if needed for stable pagination or a richer
latest-activity summary, but the first implementation should derive the feed
from `GET /api/cards` as the current board does.

Reusable frontend concepts should include `AppShell`, `WorkSection`,
`TaskRow`, `StatusMark`, `PrimaryTaskAction`, `OverflowMenu`, `BottomSheet`,
and `ResponsiveDialog`. Names are illustrative, not a framework mandate. Avoid
building separate mobile and desktop applications.

## Acceptance criteria

The redesign is complete when:

1. At 320 CSS px wide, the Work screen, task detail, review, analytics, and
   settings have no page-level horizontal overflow.
2. A user can create, prioritize, start, inspect, restart, review, approve, and
   reject a task without drag or hover.
3. The default Work view visibly prioritizes every Review and Needs Attention
   task above active and queued work.
4. The Todo queue can be reordered using touch and keyboard, with its result
   persisted through the existing position field.
5. Bottom navigation and sticky action bars clear device safe areas and the
   mobile keyboard.
6. The same repo/view filters survive refresh and browser Back/Forward.
7. Live updates do not reset scroll, filters, focused controls, expanded
   content, or transcript reading position.
8. Review actions remain reachable while reading long diffs and pending actions
   cannot be double-submitted.
9. Status, progress, and validation are understandable without colour alone;
   focus order and dialog behavior pass keyboard testing.
10. Wide layouts use added space for readable context, not a return to
    horizontally scoped status lanes.
