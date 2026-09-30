# 22: Scheduling queue drains and improvement runs

Decided 2026-09-22. Amends hard rule 2 of
[06-self-improvement.md](06-self-improvement.md) — "Nothing starts without a
user action: cards are started explicitly, an Improvement Run by button. No
crons in v1" — which that spec itself names as the first post-v1 step under
*Trajectory*. Roadmap backlog item 4 in
[07-roadmap.md](07-roadmap.md#backlog-once-it-works-cards-for-radulfs-own-board).

No other locked decision moves. A schedule starts nothing that a button
cannot already start, by no path a button does not already take, and decision
6 still requires a human `reviews.decision = approved` before anything merges.

## The problem

Two things want to happen when nobody is watching, and today both need
somebody watching.

**Draining the queue.** Cards accumulate in the Queue during the day. Auto
Mode drains it, but Auto Mode is a global toggle with no sense of time: on, it
claims every queued card the moment one appears, which is exactly wrong while
the operator is working in the same repository. Off, the queue sits until
somebody presses Start on each card. What is actually wanted is "work the
queue overnight", and there is no way to say that.

**Improvement runs.** A run is time-boxed and self-driving, so it is the one
piece of Radulf already shaped for unattended work, and it is the one that
most obviously wants a cadence: a nightly budget against this repository's
`beta` is a standing decision, not a decision to retake every evening. Spec 06
predicted this exact card.

## Why the autonomy boundary is not what moves

Hard rule 2 exists so that nothing Radulf does is a surprise. A schedule is
not an exception to it; it is the same user action taken once, ahead of time,
and it is auditable afterwards. What the rule is really protecting is
therefore restated rather than relaxed:

- **A schedule starts only what a button starts.** A drain calls `startCard`
  per queued card. An improvement-run schedule calls
  `createImprovementRun`. No new execution path, and every cap those paths
  enforce still applies.
- **Nothing schedulable merges.** Hard rule 1 is untouched. An improvement
  run's cards still auto-approve through the same review path they do today,
  and a drained card still stops at In Review unless it carries its own
  `autoApprove`.
- **Every firing is on the record.** A fire emits a `schedule.fired` event
  against the repo it acted on, so "why did this start at 03:00" is a
  question the board answers. A fire that was skipped, and why, is recorded
  the same way.

## Alternatives rejected

- **A time window on Auto Mode** (`autoModeFrom`/`autoModeTo` in Settings).
  Cheaper, and it solves the drain case only. It cannot express "weekdays
  only", it cannot schedule an improvement run at all, and a second mechanism
  would then be needed for those, leaving two ways to say when work happens.
- **`launchd`/`systemd` timers calling the HTTP API.** No new code in Radulf
  at all. Rejected because it needs a session cookie in a file on disk for a
  timer to use, is invisible from the app that is supposedly driving the work,
  and is per-platform, while the container image has no init system at all.
- **A `nextFireAt` column the ticker sorts on.** The usual scheduler shape,
  and worth it at thousands of schedules. Here there are single digits, so
  matching the expression against the current minute is less state to keep
  correct than a cached timestamp that a cron edit has to remember to
  recompute.
- **Seconds resolution, or `@reboot`.** Nothing wants either. Minute
  resolution is what a cron expression means to everyone who has written one.

## The decision

**A `schedules` table, two kinds, and a ticker that wakes once a minute.**

- **Kinds.** `queue-drain` and `improvement-run`, and nothing else. A kind is
  not a plugin point: a third one is a decision, not a configuration.
- **Expression.** Standard five-field cron — minute, hour, day of month,
  month, day of week — with `*`, numbers, lists, ranges, and steps, plus the
  usual three-letter month and weekday names. Parsed by
  `src/server/cron.ts`, no dependency added. Evaluated in the **server's
  local time zone**, which is the one the operator reads a schedule in.
  Day-of-month and day-of-week are OR'd when both are restricted, as in
  every crontab.
- **Scope.** A `queue-drain` schedule names one repository or all of them; an
  `improvement-run` schedule always names one, because a run is per repo by
  construction (decision 6 of spec 06).
- **A missed tick is missed, not replayed.** A server that was down at 03:00
  does not drain the queue when it boots at 09:00. Replaying an unattended
  batch into the middle of a working day is precisely the surprise hard rule
  2 exists to prevent, and the next tick is never far away.
- **A fire that cannot run is skipped, never queued.** An improvement-run
  schedule whose repo already has an active run records that and moves on;
  the one-active-per-repo rule is not something a schedule may bend. A drain
  with nothing in the queue is a no-op and says so.
- **Failures never stop the clock.** A fire that throws is recorded on the
  schedule as its `lastError` and surfaced in Settings; the schedule stays
  enabled. A broken provider must not silently disable the schedule that
  would have picked the work back up once it recovered.
- **Opt-in, and off by default.** There are no schedules until the operator
  writes one, and each carries its own `enabled` flag so a cadence can be
  suspended without losing its configuration.

## Data model

`schedules`: id, kind, repo id (nullable, and only for `queue-drain`), the
cron expression, an enabled flag, a JSON config carrying an improvement run's
own parameters (budget, focus prompt, base branch, model and reasoning
overrides, iteration and timeout caps — the same set the Start improvement
run dialog collects), `lastFiredAt`, `lastError`, and the usual timestamps.

The config is JSON rather than columns because it is an improvement run's
argument list, which spec 06 owns and will keep changing; a column per
parameter would make this table a mirror of that one.

## What this does not do

- **No scheduled card creation.** A schedule never invents work. It starts
  work that already exists as a card, or an improvement run whose job is to
  propose its own.
- **No per-schedule concurrency, budget or kill switch beyond `enabled`.**
  The per-repo pipeline cap (spec 20), the per-card iteration and timeout
  caps, and a run's own time budget are the bounds, exactly as for a button
  press.
- **No calendar UI.** A cron expression, a human-readable rendering of it,
  and the next fire time. A schedule builder is its own decision.
- **No time-zone field.** Server-local, which means a DST shift can skip or
  repeat an hour once a year for a schedule that falls inside it. Accepted:
  the alternative is carrying a zone per schedule for a single-operator app
  that runs on one machine.
