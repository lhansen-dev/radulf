# 28: Epic pieces declare dependencies, scheduled as a graph

Decided 2026-09-24. Amends [24-epics.md](24-epics.md) decisions 4 and 5 and
removes "No dependency graph" from its non-goals. Nothing else in spec 24 is
reversed: the epic still never runs, pieces are still ordinary cards, the
epic still finishes when its children do, and `ordered` and `parallel` keep
exactly the meaning spec 24 gave them.

## Motivation

The spec 25 epic was broken into six pieces and run in order, because in
order was the only mode that respected any dependency at all. Only four of
the six actually depended on each other. Pieces 3 and 5 needed piece 2.
Piece 6 needed everything before it. Piece 4 depended only on piece 1, and
could have started the moment piece 1 was done, beside piece 2.

Under `ordered` it could not. Piece 4 sat in Todo while piece 2 ran, then
while piece 3 ran, and running it beside piece 2 took a manual **Start now**:
the operator reading the pieces, working out the dependency the proposal had
already stated, and overriding the queue by hand. Under `parallel` it would
have started before piece 1 finished, which is wrong for a different reason.

With two workers, as spec 25 allows, this is the bottleneck. The repo cap
allows two pieces at once; the order rule allows one. The queue itself, not
the model and not the machine, is what holds the second worker idle. Spec 24
listed "No dependency graph" as a non-goal and said order was the whole of
it; one epic later, the line was the thing in the way.

The split prompt already asks every piece to name the pieces it depends on.
Spec 24 decision 7 used that only to pick between in order and in parallel.
This spec keeps the answer.

## Decisions

**1. A piece may name the sibling pieces it depends on.** The breakdown
editor and `POST /api/cards/:id/breakdown` accept, per piece, an optional
`dependsOn` list of 0-based piece indexes within that breakdown. On apply the
indexes are resolved to the ids of the sibling cards that were created and
persisted on the piece as `cards.depends_on`, a JSON array of sibling card
ids. An empty or missing list is stored as `null`, as are the pieces of
epics created before this spec; every reader treats `null` as no
dependencies, and under `ordered` those epics behave exactly as they did.

**2. A third run mode, `graph`.** `EPIC_RUN_MODES` gains `graph`. Under it,
`pump()` starts a Todo piece once every piece in its `depends_on` is Done or
Abandoned, and not before, bounded by the per-repo cap from spec 20 like any
other automatic start. A piece with no dependencies is eligible at once.
`ordered` and `parallel` keep their meaning exactly: `ordered` still reads
queue position and ignores `depends_on`; `parallel` still starts everything
the cap allows. The proposal recommends a mode; the operator decides, and may
switch the epic between the three at any time, as before.

**3. A dependency cycle is rejected at breakdown time.** The `dependsOn`
lists are checked before anything is written: `parseBreakdown` rejects an
index outside the breakdown or a piece that depends on itself, naming the
piece by its 1-based position, and `applyBreakdown` checks the indexes again
and walks the graph for a cycle, reporting one as the chain of piece titles
(`"A" → "B" → "A"`) so the operator can fix the editor rather than guess.
Nothing is persisted from a rejected breakdown.

**4. An abandoned dependency does not hold a piece.** A piece whose dependency
is Abandoned starts anyway, once its other dependencies are satisfied, the
same way spec 24 decision 4 lets an abandoned predecessor release the order.
When that happens the epic's activity records `epic.dependency_abandoned`,
naming the piece that started and the abandoned dependency, so the operator
can see that a piece ran on top of work that was never done. It is one event
per piece, listing every abandoned dependency it had, emitted when the piece
is started, not when the dependency is abandoned.

**5. Start now still starts a waiting piece.** As in spec 24 decision 4, a
manual start is the operator overriding the rule on purpose. The queue does
not check `depends_on` for a manually started piece. Start all (spec 24
decision 5) still queues every child and marks it manually started, then
pumps; under `graph` the pump honours the dependencies for those pieces
exactly as it honours order under `ordered`.

**6. The proposal states dependencies.** The scoping split proposal gains
`RUN: as a graph` as a third value for the run line, and a `DEPENDS ON:` line
per card listing the pieces it depends on by number, or `none`. The parser
turns those numbers into `dependsOn` indexes and defaults a missing line to no
dependencies. A missing `RUN:` line still defaults to in order, as spec 24
decision 7 said.

**7. The feed shows what a piece is waiting on.** In the Work feed's epic
group, a Todo piece under `graph` that is not yet eligible lists the sibling
pieces it is waiting on, by title, so the operator can tell a piece held by a
dependency from one held by the cap or by Auto Mode being off.

## Data model

- `cards.depends_on`: nullable JSON text, an array of sibling card ids.
  `null` on pieces created before this spec; meaningful on a card with a
  parent whose epic runs as `graph`.
- `cards.run_mode` accepts a third value, `graph`, alongside `ordered` and
  `parallel`.
- Events: `epic.dependency_abandoned`, on the epic, when decision 4 fires,
  with `pieceId` (the piece that started) and `abandoned` (the ids of its
  abandoned dependencies).

## What this does not do

- **No cross-epic dependencies.** `depends_on` only ever names siblings under
  the same parent. A piece cannot wait on a card in another epic or on a card
  with no parent.
- **No editing dependencies after the breakdown.** Once applied, the graph is
  fixed. The operator can switch the epic's run mode among the three, reorder
  the queue for `ordered`, or start a piece by hand, but there is no editor
  for `depends_on` on an existing epic. Getting the graph wrong means
  breaking the epic down again.
- **No change to a single card.** How a piece plans, loops and is evaluated
  is untouched. A dependency only decides when the piece may start.
