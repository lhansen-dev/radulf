VERDICT: approve

## What I verified

Ran every acceptance-criteria command myself in this worktree (offline deps present, `node_modules` is a real copy, not a symlink):

- `grep 'jiraKey: text("jira_key")' src/db/schema.ts` — pass.
- Migration: the literal `drizzle/0025_jira_key.sql` check **fails**, but only because `beta` gained `0025_precheck_passing_plan_row` after the criteria were written. The card says to "chain on whatever landed", and the branch does exactly that: `drizzle/0026_jira_key.sql` (`ALTER TABLE cards ADD jira_key text;`), journal idx 26 after beta's idx 25, `0026_snapshot.json` has `prevId` = beta's 0025 snapshot id and differs from it only by the `jira_key` column. `drizzle-kit check` → "Everything's fine"; `drizzle-kit generate` → "No schema changes" (schema matches the snapshot, nothing written). I treat this criterion as met.
- `vitest run cardValidation.test.ts jira.test.ts` → 55 passed. `isJiraIssueKey` exported; create/update/breakdown accept a key or null (upper-cased), reject a URL, prose, or a number.
- `vitest run newTaskDialog.test.tsx 'card/[id]/page.test.tsx' cardTransfer.test.ts requestValidation.test.ts settings.test.ts` → 98 passed. Dialog sends `jiraKey` on the card and each child piece; card page links `<jiraBaseUrl>/browse/<key>` via `jiraUrl` from `GET /api/cards/[id]`; export/import round-trips and drops an unrecognised key rather than refusing the file.
- `vitest run jiraAnnounce.test.ts reviewService.pr.test.ts reviewService.test.ts orchestrator.scoping.test.ts docs.test.ts` → 80 passed. Announce tests assert URL (`/rest/api/2/issue/DEV-7/comment` via the gateway), Basic auth header, JSON `{body}` with title/branch/short sha/card ref, off/no-key/blank-URL make no request and emit nothing, 401/404/network/timeout emit `jira.comment_failed` with a reason, throwing `emitEvent` still resolves. Review tests 9–9e cover merge, PR, off, no key, and the cleanup-rejects regression (exactly one comment attempt, card still moved to done). Epic test asserts one comment for the parent when its last piece closes.
- All greps in the criteria pass: `"jiraKey"` in cardValidation, cards route, `jiraKey: piece.jiraKey` in orchestrator, `jiraUrl` in `[id]/route.ts`, `jiraCommentOnDone: false` + `"jiraCommentOnDone"` in settings.ts, `toggle("jiraCommentOnDone")` in settings page, `"jiraApiToken"` still in the secrets list, `jiraBaseUrl must use http or https` untouched, `rest/api/2/issue/` + `/comment` + `AbortSignal.timeout` in jiraAnnounce.ts, `announceCardDone` in orchestrator.ts, `jiraCommentOnDone` in docs/HOW_IT_WORKS.md.
- `awk` ordering check: inside `completeApproval`, `await announceCardDone(card, outcome)` sits right after the `moveCard(..., "done")` guard and before `removeBaseline`/`removeWorktree`; cleanup error semantics unchanged.
- `tsc --noEmit` exit 0; `eslint` exit 0 (3 warnings, 2 pre-existing).
- Repository gate `make check` exit 0 (from GATE.md).

Code review beyond the criteria: only two code paths move a card to `done` (`reviewService.completeApproval`, `orchestrator.completeEpicIfFinished`) and both announce; `mergeCommit` is always set when `mergeBranch` returns `ok`, so the `!` is safe; the failure payload carries only key/status/reason — never headers or token; events render generically on the Activity tab so both new types appear. No unrelated changes; worktree clean.

## For the human reviewer

- The migration is `0026_jira_key`, not `0025` as the criteria text said — expected, because beta already took 0025.
- `RADULF_PUBLIC_BASE_URL` is a **new** env var (documented in HOW_IT_WORKS.md) for the card link; unset → bare card id in the comment. `RADULF_ALLOWED_ORIGIN` already exists and might have served as a fallback.
- Worst-case wait in the approve request: `restRoot` does an unauthenticated `_edge/tenant_info` lookup with its own 10 s timeout before the 10 s comment POST, so an unreachable Jira can hold the approval response (and worktree cleanup) for ~20 s rather than ~10 s. Still bounded and never fails the card.

```findings
[
  { "severity": "important", "file": "src/server/jiraAnnounce.ts", "line": 84, "issue": "restRoot's own 10 s tenant_info timeout runs before the 10 s comment timeout, so an unreachable Jira can delay the awaited approve path by ~20 s instead of the ~10 s the card asks for; share one deadline or pass a shorter timeout to restRoot." },
  { "severity": "suggestion", "file": "src/server/cardValidation.ts", "line": 65, "issue": "jiraKey() declares an unused `field` parameter (new eslint no-unused-vars warning); drop it or use it in the message." },
  { "severity": "suggestion", "file": "src/server/jiraAnnounce.ts", "line": 30, "issue": "RADULF_PUBLIC_BASE_URL is a new env var; consider falling back to the existing RADULF_ALLOWED_ORIGIN so most deployments get a card link without new configuration." }
]
```
