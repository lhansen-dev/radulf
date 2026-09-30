# 17 — Scoping a card before it is planned

Decided 2026-09-20. Extends [04-agent-pipeline.md](04-agent-pipeline.md) with a
stage that runs before planning, and amends decision 3 by adding a fourth agent
role alongside planner, loop and evaluator.

No locked decision is reversed. Decision 1 still scopes cards to coding tasks
against a registered repo, decision 6 still requires human approval to merge,
and planning still produces the three `.ralph/` artifacts exactly as spec 04
describes. What changes is what the planner receives.

## Motivation

A card whose description is one vague paragraph produces a bad plan, and a bad
plan poisons every iteration after it. Radulf already has two mechanisms aimed
at this problem. Neither works, and they do not know about each other.

**The planner chat cannot read the repository it is scoping for.**
`plannerChat()` in `src/server/chat.ts` runs `runHarness` with
`cwd: process.cwd()`, which is Radulf's own directory rather than the card's
repo. Its preamble asks it to help "produce a clear description with a
definition of done", but it is doing that blind, so every question it asks is
generic. It is also stateless: each turn flattens the entire transcript into a
single string prompt against a 120s timeout, with no session. And its output is
discarded. Only the text the user clicks "Insert into description" survives; the
reasoning, the options weighed and the paths ruled out do not, and nothing ties
the conversation to the card that came out of it. The feature is reachable only
under Advanced in the new-task dialog.

**The planner can ask questions, but cannot be answered.**
`planningService.ts` reads `.ralph/QUESTIONS.md` after a planning run. When the
planner judges a card too underspecified to plan, it writes its blocking
questions there, and Radulf commits them, emits `plan.questions`, and moves the
card to Needs Attention. That is where the mechanism ends. There is no way to
reply. The operator edits the description and triggers a fresh planning run that
starts from nothing, and the planner's questions and the operator's answers
never become part of the card.

So Radulf can ask what it needs, and the operator can talk to Radulf about
scope, and the two never meet. Both halves also forget everything as soon as
they finish.

Observed on 2026-09-20: two cards against this repo, both with descriptions a
human would call detailed, failed at the planning stage (one timeout, one
malformed artifacts) on a 64K self-hosted model. Neither reached an iteration.

## The shape

One mechanism, a **scoping session**: a persisted, repo-aware conversation
attached to a card, enterable from either direction.

- **Forward.** The operator starts with a rough ask. The session interrogates it
  until the scope, the constraints and the definition of done are explicit.
- **Backward.** A planning run raises `QUESTIONS.md`. Those questions open (or
  continue) the card's scoping session rather than parking the card with a file
  the operator has to read and reconcile by hand. Answering continues a
  conversation rather than restarting one.

Three properties carry the design.

### It runs in the card's repository, read-only

The session uses `createRalphSession` with `readOnly: true` and the role's path
guards, against the card's repo, not `process.cwd()`. This is the whole
difference between asking "what should the acceptance criteria be?" and asking
"there are two session modules here, `src/server/session.ts` and
`authSecret.ts`; which one does this touch?".

It holds the read-only tool set (`read`, `grep`, `find`, `ls`) and no `bash`,
which keeps it on the correct side of spec 14's role capability split: a role
with repository read access and no command execution. It gets `web_search` on
the same terms the planner does.

### The thread is part of the card

Scoping messages persist against the card, not in a transcript file that only a
run points at. Two consumers follow from that:

- The **planner** receives the thread as context, so the decisions reached in
  scoping constrain the plan instead of being re-derived from a summary.
- The **evaluator** can judge the change against what was actually agreed,
  rather than against a one-paragraph description that predates the agreement.

This is also the durable record of why a card is shaped the way it is, which
today exists nowhere.

### It ends by producing something concrete

A session does not end with prose. It ends by proposing one of:

1. **A scoped card**: a rewritten description plus acceptance criteria, for the
   operator to accept or edit.
2. **A split**: several ordered cards, when the ask turns out to be more than
   one piece of work. The operator approves, edits or rejects the proposal; a
   split is never applied on its own. This needs card ordering, so that the
   cards produced carry the sequence the session found.
3. **A plan**: `PLAN.md` and `CRITERIA.md` directly, skipping the planning
   stage. See below; this one is opt-in per card.

## Decisions

**A fourth role.** Scoping gets its own provider, model and reasoning level in
Settings, alongside planner, loop and evaluator. It is not folded into the
planner's configuration. The two have opposite shapes: planning is batch, runs
once per card and can be slow, while scoping is interactive, turn-by-turn, and
wants a strong model precisely because the operator is waiting on it. Tying them
together is what currently points an interactive chat at whatever was chosen for
batch planning. The role-fit advisory in Settings covers it like the others.

**Plan authoring is opt-in per card, not the default.** A card carries a flag,
alongside `reviewPlanBeforeImplementation`, that lets its scoping session emit
the plan artifacts directly and skip planning. Default off: planning stays the
one path that produces a plan, per the repo's preference for a single code path.
The flag exists because when the planner is the weakest link in the pipeline,
being forced through it is the failure mode, not the safeguard. A card that
carries its own plan is stamped as such on the plan row, so the origin of any
plan is always recoverable.

**A split is a proposal, never an action.** Consistent with decision 6's posture
on merging: the agent proposes, the human disposes. A rejected split leaves the
original card untouched.

## Data model

- `scoping_messages`: card id, role, content, created_at. The thread.
- `cards`: a flag for scoping-authored plans, and an ordering column so a split
  can express sequence.
- `plans`: an origin column distinguishing a planner-produced plan from a
  scoping-authored one.
- `settings`: provider, model and reasoning level for the scoping role.

## What this does not do

- **No dependency graph.** A split produces ordered cards, not a DAG. Blocking
  relationships between arbitrary cards are a separate problem.
- **No automatic scoping.** A session is started by the operator, or by a
  planner that raised questions. Radulf does not decide on its own that a card
  is too vague and open one.
- **No change to the loop or the evaluator gate.** Everything downstream of
  planning is untouched.
- **Plan editing is not introduced here.** Plans remain produced rather than
  hand-edited; scoping can author one, but there is still no free-text edit of
  an existing plan. That may deserve its own spec.
