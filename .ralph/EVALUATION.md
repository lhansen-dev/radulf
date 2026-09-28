VERDICT: approve

## What I verified (this attempt, HEAD 38020b0, merge-base 3358191)

Every acceptance-criteria command was re-run by me; the results match the
previous (killed) attempt, which evaluated the identical HEAD:

- All grep/diff criteria PASS: `inspectRepoIntegrity` exported and
  `startsWith("refs/remotes/")` in `src/server/integrity.ts`;
  `emitEvent("repo.integrity_warning"` in `src/server/stage.ts`; the event type
  handled in `src/app/card/[id]/page.tsx`; `Amendment (2026-09-25)` in spec 19
  with **0 removed lines**; `amended 2026-09-25` in `docs/DESIGN_HISTORY.md`;
  `repo.integrity_warning` in `docs/SANDBOXING.md` and
  `docs/TROUBLESHOOTING.md`; the stale "tags and remotes are still compared"
  sentence is gone and no doc under `docs/` still claims remotes are compared;
  no `src/db/` or `drizzle/` change.
- `npx vitest run src/server/integrity.test.ts` → 16/16 pass. I read the new
  test bodies: moved `refs/remotes/origin/beta` + appeared
  `refs/remotes/origin/new-branch` → `violations: []`, two warnings naming both;
  pruned remote ref → `["ref deleted: refs/remotes/origin/gone"]` only; moved
  `refs/heads/beta` with no `ref_writes` row → one `ref moved: refs/heads/beta`
  violation, no warnings. Hook / `.git/config` / `ralph/` exemption /
  `checkRefs: false` / `ref_writes` / lease re-read tests are unchanged and pass.
- `npx vitest run src/server/stage.test.ts src/server/mockPipeline.test.ts -t
  "integrityViolationReason|remote-tracking ref noise"` → 3 pass (stable across
  4 runs over both attempts). The e2e asserts `review`, `done-signal`, and
  exactly one `repo.integrity_warning` on the loop run naming
  `refs/remotes/origin/beta`. The `afterLoopBaseline` hook keys off
  `run.started`, which the orchestrator emits after `snapshotRepoIntegrity`, so
  the injection lands deterministically inside the baseline→check window.
- Previous attempt (same HEAD): `page.test.tsx` 22/22, eslint on all card files
  exit 0, `tsc --noEmit` exit 0, full vitest 1430 tests green.
- Repository gate `make check` → exit 0 in 57s (`.ralph/GATE.md`), so the
  full-gate criterion is satisfied here — no external CI run needed.

## Code review

- Classification change is confined to the `compareRefs` closure: the
  `ref_writes` exemption is applied first, then a non-managed `refs/remotes/**`
  diff goes to `warnings`, everything else to `violations`. Message wording is
  unchanged. The lease-settle re-read keys off `violations` only, which is
  correct: Radulf only ever writes `refs/remotes/*/ralph/*` (still managed) and
  never fetches in the parent, so a remote-only diff has nothing to wait for.
- `checkRepoIntegrity` is kept as a thin wrapper returning `.violations`, so
  `reviewService.ts` (pre-merge, `checkRefs: false`) is untouched.
- `integrityViolationReason` (stage.ts) emits the warning event before deciding,
  so a warning is never swallowed by a co-occurring real violation. Both call
  sites (orchestrator loop end, evaluationService) pass `{cardId, runId}`.
- Timeline row (`page.tsx`) parses `payload.refs` defensively and falls back to
  the raw event line if the payload is malformed.
- Spec 19 amendment is append-only; DESIGN_HISTORY, SANDBOXING, TROUBLESHOOTING
  reconciled by the loop. No further doc edits needed from me.

## For the human reviewer

- **Out-of-card changes ride along** (loop tasks 5–6, "gate repair"):
  `Makefile` (`check-deps` prerequisite), `CONTRIBUTING.md`,
  `src/server/transcript.ts` (+142, event-driven wait for a not-yet-created
  transcript file), `src/server/transcriptWatchers.ts` (arm from the start
  event), their tests, `docs/ARCHITECTURE.md`, and two amendment paragraphs in
  `specs/25-web-and-worker-processes.md`. These were needed to get `make check`
  green in this worktree and are not part of the card's scope. They pass the
  gate and their tests were stable across 3 reruns, but they deserve a
  deliberate look — especially the `transcript.ts` directory-walk logic.
- Local `beta` has advanced one commit (d720bd6) since the merge-base; expect
  the merge step to re-sync.
- Ironically, the previous evaluator attempt on this card was killed by the
  *old* integrity check firing on `refs/remotes/origin/beta` in the parent
  checkout — a live reproduction of the bug this card fixes.

```findings
[
  { "severity": "important", "file": "src/server/transcript.ts", "issue": "Unrelated to the card: +142 lines of event-driven transcript-appear logic (and transcriptWatchers.ts, Makefile check-deps, spec 25 amendments) landed as 'gate repair'; tests are green but this scope creep should be reviewed on its own merits." }
]
```
