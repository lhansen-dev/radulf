# 24: Epics, breaking one ask into many tasks

Decided 2026-09-23. Extends [17-task-scoping.md](17-task-scoping.md), whose
split becomes a breakdown under a parent card, and amends the "what this is
not" list in [20-concurrent-cards.md](20-concurrent-cards.md) by adding one
scheduling rule: the pieces of an epic can be held to their order. No locked
decision is reversed. Merging still needs a human, every piece still goes
through the evaluator, and one card is still one agent working one checklist.
Decisions 4 and 5 and the "No dependency graph" non-goal are amended by
[28-epic-dependency-graph.md](28-epic-dependency-graph.md).

## Motivation

`PRODUCT.md` names multi-task epics as the stated direction, and spec 20 ends
by saying that splitting one epic across agents belongs in its own spec. This
is that spec, and it is narrower than the coordination problem spec 20 had in
mind, because the friction observed on 2026-09-23 is upstream of coordination.
Getting from one large ask to several running tasks takes seven stops today:

1. The New task dialog, with a title and a description, or one Jira issue.
2. **Create and scope**, which opens the card.
3. The scoping panel, at the bottom of the Task tab.
4. **Propose a split**, then a wait of one to five minutes.
5. Editing the pieces in a stack of text areas.
6. **Queue N cards**.
7. Settings, to raise **Concurrent cards per repo** so they run together.

Four things make it clunky, none of them cosmetic.

**Splitting is a side output of the chat.** It exists only on the card page,
after the card exists, and only as the third thing a scoping session can end
with. There is no way to break a description down from the dialog, and no way
to break down a Jira epic at all: the Jira import fetches one issue and
prefills one card.

**Pieces have no shared identity.** `applyScopingSplit` rewrites the original
card into piece one and inserts the rest as unrelated rows. The `card.split`
event is the only record that they belong together, and nothing reads it. The
Work feed shows five rows with nothing in common, there is no progress for the
whole, no way to start or pause the set, and a review that arrives says
nothing about which epic it belongs to.

**Order and concurrency contradict each other.** The split prompt asks every
piece to name the earlier piece it depends on, and the pieces are queued in
that order. Raising the concurrency cap starts them together regardless, and
nothing checks the dependency the prompt asked for. Whether pieces may run at
once is a property of the work, and today it is a global dial.

**The wait is blind.** Fixed on the same day, before this spec: scoping turns
now push their transcript live, and the panel shows what the session is
reading. It is listed here because the split turn is the longest scoping call
and was where the blindness hurt most.

## The shape

**An epic is a card with children.** A card whose breakdown has been applied
keeps its title, its description and its scoping thread, and gains children:
ordinary cards that point back at it. The epic itself never runs. It reads as
done when its children are.

**One breakdown, three ways in.** A breakdown is a list of pieces and a run
mode. The scoping session proposes one from the card and its thread, as the
split did. **Create and break down** in the New task dialog creates the card
and asks for that proposal straight away. A Jira issue with child issues
offers those children as the pieces, in the dialog, before the card exists.
The first two share one editor on the card page; the third is a checklist in
the dialog, because Jira already wrote the pieces and the operator's decision
is which of them to take.

**Run mode belongs to the epic.** In order, or in parallel. In order means the
queue starts a piece only once every piece before it has finished. In parallel
means the pieces are eligible at once and the repo cap from spec 20 bounds
them. The proposal says which it recommends; the operator decides.

## Decisions

**1. A parent column, not a new table and not a new status.** `cards` gains a
nullable `parent_card_id` referencing `cards.id`, and a nullable `run_mode`.
An epic is any card with at least one child. Its own `status` column only
ever holds `backlog` or `done`; everything else about it is read from its
children. A new status would have touched every status switch in the app for
a row that is never scheduled.

**2. The epic never runs.** Queueing or starting a card that has children is
refused. The pump only reads Todo, and an epic is never in Todo, so this is a
guard on the two entry points rather than a change to the queue.

**3. Pieces are ordinary cards.** They inherit the epic's per-card settings, as
split cards did, and each may target a different repository than the epic:
the epic keeps its home repository for the scoping session, and a piece in
another repository carries no base branch, since the epic's belongs to its
own repository. Nothing coordinates two pieces in different repositories;
they schedule independently under each repository's cap, which is exactly
what spec 20 already does for unrelated cards.

**4. Order is enforced by the queue, for automatic starts only.** Under
`ordered`, `pump()` skips a Todo piece while any sibling with a lower queue
position is not yet done or abandoned. The order is the queue position the
pieces were given when the breakdown was applied, which the operator can
change by reordering the queue. **Start now** on a piece still starts it,
because a manual start is the operator overriding the rule on purpose. A
piece that lands in Needs Attention holds the rest, which is the point of
choosing in order.

**5. Start all and Pause all act on the epic.** Start all queues every child
still in Backlog and marks every queued child as manually started, then pumps,
so the order rule is honoured even with Auto Mode off. Pause all pauses every
child that is looping. Both are the same per-card actions applied to the set,
not new states.

**6. The epic finishes when its children do.** When a child reaches Done or
Abandoned and no sibling remains in any other status, the epic moves from
Backlog to Done and emits `epic.completed`. Deleting an epic detaches its
children rather than deleting them: they are real work with real history.

**7. The proposal states its run mode.** The split prompt gains one line,
`RUN: in order` or `RUN: in parallel`, with the pieces' dependencies as the
reason. The parser defaults to in order when the line is missing, because
that is what the queue did before.

**8. Jira children come from the issue itself.** `GET /api/jira/issue` also
returns the issue's child issues, from Jira Cloud's `search/jql` endpoint with
`parent = KEY`, which covers epics in both project types since Jira unified
the parent field. Each child is shaped as a card draft the same way the issue
is. The dialog lists them with a checkbox each and a run mode, and one Create
creates the epic and the chosen children.

**9. The feed shows the group.** A piece's row names its epic. An epic with
children leaves the Backlog rows and appears as a group header with its
progress, and its page lists the children with their statuses and the two
epic actions.

## Data model

- `cards.parent_card_id`: nullable, references `cards.id`, set null on delete.
- `cards.run_mode`: nullable text, `ordered` or `parallel`, meaningful on a
  card with children.
- Events: `card.breakdown` replaces `card.split`, with the child ids and the
  run mode; `epic.completed` when decision 6 fires.

## What this does not do

- **No dependency graph.** Order is the whole of it. A piece that depends on a
  piece two places back still waits for the one in between.
- **No coordination between agents.** Two pieces that touch the same file in
  parallel conflict exactly as two unrelated cards do.
- **No nested epics.** A card with a parent cannot be broken down.
- **No epic export.** Card export still travels one card at a time; the
  parent link does not travel with it.
- **No reopening.** A child reset after the epic completed does not reopen
  the epic.
