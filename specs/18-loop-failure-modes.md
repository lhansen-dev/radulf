# 18 — The loop's unhandled failure modes

Decided 2026-09-20. Amends [11-loop-performance.md](11-loop-performance.md),
whose per-iteration hard timeout and adaptive budget are the mechanisms most of
this changes. No locked decision is reversed: merging still requires human
approval, one ticket still moves through the pipeline at a time, and every DONE
still goes through the evaluator before a human sees it.

Spec 11 asked "how long should an iteration get". This spec asks the question
underneath it: **when an iteration ends badly, what does Radulf actually know,
and what does it do with that knowledge.** The answer today is "less than it
has on disk", and the cost is measured below.

## The evidence

One card, `Build CLI integrations`, run on the stable deployment between
13:44 and 21:52 on 2026-09-20. Twenty-two runs, nineteen loop iterations, eight
hours of wall clock. Roughly four of those hours produced nothing, in three
roughly equal parts:

| Waste | Cost |
|---|---|
| Five consecutive evaluator runs against a model that could not finish one | ~50 min |
| The card parked in Needs Attention with nobody notified | ~115 min |
| Re-doing work that a timed-out iteration had already finished | ~70 min |

Every number below comes from that card's `runs`, `iterations` and `events`
rows. The point of writing them down is that each one was already in the
database while the loop was making the wrong decision.

## 1. A timed-out iteration's work is thrown away

`orchestrator.ts` handles `result.timedOut` and `continue`s *before* it calls
`performIterationBookkeeping`. So when the hard timeout fires:

- an `.ralph/ITERATION_DONE` the agent wrote seconds earlier is never read, so
  the checklist tick and the deterministic commit never happen;
- the missing-signal path is never reached either, so `consecutiveUnsignalled`
  does not move and `SIGNAL_REMINDER` is never armed;
- the same task is re-injected with the identical prompt that just failed.

Iteration 8 spent 10.0 minutes and 62 tool calls on task #8 and was killed.
Iteration 9 was handed task #8 again and finished it in **0.5 minutes and 10
tool calls** — the files were on disk the whole time, uncommitted and
unrecorded. Iteration 4 of the last run spent 60.0 minutes and 172 tool calls
on task #7, was killed, and its final message read "I've successfully completed
the task as requested ... ready for orchestrator review". Iteration 5 was
handed task #7 again.

**Decision.** The timeout path runs bookkeeping like any other ending. The
worktree is preserved across a timeout either way, so reading a signal file
that is already there costs nothing and can only bank work Radulf would
otherwise discard. When the killed iteration left no signal, it counts as
unsignalled, which arms the reminder for the retry.

## 2. The two-timeout kill switch cannot fire

Spec 11 ends a run on two consecutive iteration timeouts.
`consecutiveIterationTimeouts` resets on any iteration that does not time out.
But the timeout path retries the same task, and because of §1 that retry
usually succeeds in seconds against work already on disk. The counter resets,
and the rule never fires. Both timeouts on this card logged `consecutive: 1`.

**Decision.** Count iteration timeouts per run. Two timeouts in a run end it,
whatever happened between them. The consecutive counter was measuring the
retry's success, not the run's health.

## 3. Radulf has no notion of an unretryable error

`classifyProviderError` knows two kinds, `conn` and `limit`. Everything else is
an ordinary failure that burns one of three attempts and is offered to the
operator as a retry.

Three planning runs, anthropic/claude-fable-5-1, at 15:28, 15:29 and 16:56,
each `turns=1, tokens=0/0`, each under a second, each returning:

```
400 {"type":"error","error":{"type":"invalid_request_error",
"message":"Claude Code 2.1.75 does not support this model;
version 2.1.251 or newer is required"}}
```

Nothing about that changes on retry. The operator retried it three times
because the UI offered a retry button and said nothing else.

**Decision.** A third kind, `config`: a request the provider rejected as
malformed or unsupported, as opposed to one it could not serve right now. A
`config` failure parks the card with the provider's own message as the reason
and suppresses the retry affordance until the model or provider changes. It
does not trip the circuit breaker — the provider is fine, the request is not.

## 4. A stage that keeps failing the same way is never diagnosed

Five consecutive evaluator runs on `omlx`: one stuck, three ten-minute
timeouts, each burning around a million prompt tokens over 34 to 99 turns. The
sixth, on chatgpt/gpt-6-astra, returned a verdict in **12 turns and 36k
tokens**. This was a model-capability mismatch, and every fact needed to say so
was already in the `runs` table.

**Decision.** When a stage fails three times in a row on the same provider and
model with the same class of exit reason, emit `stage.misconfigured` and put
the diagnosis in the card's move reason: which stage, which provider and model,
how many attempts, and that a different model is the next thing to try. Plain
retry stays available — this is a diagnosis, not a lock.

## 5. Needs Attention has no clock

The card sat in Needs Attention for 21 minutes, then for 86 minutes
(15:29:54 to 16:56:19), with nothing to notice it. Notifications are the
browser `Notification` API, raised from `useWorkData.ts`, so they reach an
operator only if a tab is already open on the right machine.

**Decision.** A watchdog emits `card.attention_stale` once per entry into
Needs Attention, after a configurable delay (default 15 minutes). It writes an
event like everything else, so the existing stream carries it, and a webhook
sink lets it leave the machine. One event per entry, never a repeat: this is a
signal, not a nag.

## 6. A user pause is recorded as a successful run

The loop's pause path calls `finishRun(runId, "completed", "paused by user")`.
`RunStatus` has had a `"paused"` member all along; nothing ever wrote it.
`analytics.ts` counts `completed` as the numerator of `successRate`.

Run `8lrZOjk8` is one iteration, 51.6 minutes, `taskCompleted = 0`, status
`completed`. It achieved nothing and scores as a success.

**Decision.** `FinishStatus` gains `"paused"` and the pause path uses it. A
paused run is not terminal, so it leaves the success rate entirely rather than
counting against it — the operator stopped it, it did not fail.

## 7. The DONE signal is self-asserted

Loop `xwWk10ZR` exited `done-signal` at 14:13. Four evaluator runs and about
fifty minutes later the verdict was "2 to 18 pass; 1, 19 and 20 fail". The loop
declared itself finished and nothing checked before the expensive stage began.

Acceptance criteria are prose with commands embedded in backticks, and some
carry a judgment a shell cannot make ("returns at least 3 wrapper scripts"). So
a passing exit code does **not** prove a criterion. A failing one does disprove
it, and that asymmetry is all this needs.

**Decision.** At DONE, extract the backticked commands from the plan's
acceptance criteria and run each one in the worktree, read-only in intent and
bounded to 30 seconds. Use the result only negatively: a non-zero exit means
that criterion is not met. On failure emit `acceptance.probe` and hand the loop
one repair iteration with the failing commands and their output, **once per
run**. After that pass the card to the evaluator regardless. The bound matters
because a criterion can be permanently unsatisfiable — criterion 1 on this card
greps `.ralph/PLAN.md`, a file the loop is deliberately forbidden to have, so
it could never pass no matter how many repair passes it got.

## 8. The adaptive budget cannot engage on the runs that need it

`iterationBudgetMs` needs `BUDGET_MIN_SAMPLES = 3` productive iterations before
it bounds anything, and `productiveMs` is seeded empty on every run. The run
that burned 60 minutes on one iteration had two samples. Worse, the samples it
does collect include thrash that happened to end with a signal — 14.9 and 59.1
minutes — so the median it would eventually learn is the thrash.

**Decision.** Seed `productiveMs` from the iterations of this card's earlier
loop runs on the same plan. This card had seventeen completed iterations to
learn from when it started the run that burned the hour. Take the lower
quartile rather than the median, so one 59-minute outlier cannot license the
next one, and keep spec 11's floor so the bound can never make a loop
unrunnable.

## 9. Prompt growth is unbounded and unwatched

Prompt tokens per loop run on the same branch and the same plan: 645k, then
1.9M, then 3.2M, then 6.8M. No event, no ceiling. `costUsd` is 0 for every
`omlx` run, so the one budget signal Radulf has is blind on the provider
actually in use.

**Decision.** Compare each iteration's prompt tokens against the median of the
run's earlier iterations. Beyond a multiple of it, emit `iteration.bloat`; on a
second consecutive bloated iteration, end the run. Token count is the honest
unit here because it is reported by every provider, unlike cost.

## 10. `iteration.slow` fires on nearly everything

`SLOW_ITERATION_MS` is a flat five minutes. It fired on 11 of this card's 19
iterations, and on 5 of 5 in the last run. A signal that fires on almost every
iteration is not one.

**Decision.** Keep the flat threshold as the floor for a run with no history,
and otherwise raise it to the iteration budget's own scale, so "slow" means
slow for this run rather than slow in the abstract.

## What this does not change

The stuck detector's consecutive-repeat streak stays as it is.
`stuckDetector.ts` records that widening it to a sliding window was measured
against 18 recorded iterations and killed 2 that went on to complete their
task. Nothing in this card's evidence argues against that measurement, and this
spec does not relitigate it.
