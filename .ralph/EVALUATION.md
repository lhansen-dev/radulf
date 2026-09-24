VERDICT: revise

## Summary

The change is correct and complete for everything the card enumerated, and every
one of the 16 private acceptance criteria passes (details below). It is sent back
for one concrete, in-scope gap: the card's headline criterion — "`make test`
passes inside a Radulf evaluator or loop run on this repository, with `TMPDIR`
left as the sandbox sets it" — is still not met. I ran `make test` once, inside
the sandbox (`TMPDIR=/tmp/claude`, `SANDBOX_RUNTIME=1`, `/tmp` read-only),
without touching `TMPDIR`:

```
 ❯ src/server/evaluationService.test.ts (24 tests | 3 failed)
     × honours a complete verdict the attempt wrote before the watchdog killed it
     × still fails a timeout that left no usable verdict behind
     × runs the gate before the evaluator and hands its result over as evidence
 Test Files  1 failed | 135 passed | 1 skipped (137)
      Tests  3 failed | 1294 passed | 30 skipped (1327)
make: *** [Makefile:87: test] Error 1
```

These three failures are pre-existing (they fail identically on a `git archive
beta` export run in the same sandbox), so the loop did not introduce them — but
their cause is exactly the class this card exists to fix (a test that needs the
real sandbox, running nested inside Radulf's sandbox), the fix is test-only
(inside the card's "test files and test utilities only" constraint), and without
it the card's title and first acceptance criterion remain false. Nothing else is
wrong; the next plan should be this one item.

## The remaining defect — what to change

**File:** `src/server/evaluationService.test.ts`

**Root cause.** The test at line 487, `"PLAN.md Phase 18.1 regression: does not
violate events.run_id FK when sandboxWeakerIsolationForGoTls is on"`, sets
`mocks.settings.sandboxEnabled = true` and queues a verdict via
`mockEvaluationVerdict(...)` (which is `mocks.runHarness.mockImplementationOnce`).
Inside Radulf's sandbox, `runEvaluator` reaches `sandboxUnavailableReason()` →
`initializeSandboxRuntimeOnce()`, which returns

```
{"ok":false,"errors":["sandbox startup failed: listen EPERM: operation not permitted /tmp/claude/srt-mux-47-0.sock"]}
```

(a nested sandbox cannot start — same reason the `srt.test.ts` real-runtime
suites now skip). `runEvaluator` therefore takes `fail(sandboxError)` and never
calls `runHarness`. The Phase 18.1 test itself still passes (it only asserts the
`sandbox.weaker_isolation_enabled` event and the `runs` row), but its queued
`Once` implementation survives `vi.clearAllMocks()` — `mockClear` empties
`mock.calls`, it does not drop the once-queue — and is consumed by the next
test's harness call. Every later `Once` is then shifted by one, producing the
three failures:

- line 651: `expected [] to have a length of 1` — the "honours" test got the
  stale approve verdict (not timed out), so no `evaluation.recovered_after_timeout`.
- line 664: `finishRun` called with `"completed", "approve"` instead of
  `"timeout", "evaluation timed out"` — it consumed the "honours" test's mock.
- line 732: `moveCard` called with `"needs_attention", "evaluation timed out"`
  instead of `"review", "evaluator approved"` — it consumed the "still fails" mock.

Bisect evidence: `vitest run src/server/evaluationService.test.ts -t "(PLAN.md
Phase 18.1 regression|honours a complete verdict)"` fails; pairing "honours" with
any other earlier test passes.

**Fix (all test-only; do both 1 and 2):**

1. Skip the Phase 18.1 test when nested inside Radulf's sandbox, using the same
   signal `srt.test.ts` now uses (`process.env.SANDBOX_RUNTIME === "1" ||
   process.env.GIT_SSH_COMMAND === "/bin/false"`), e.g. `it.skipIf(insideRadulfSandbox)(...)`
   with a one-line comment saying why (real srt preflight cannot start nested).
   Preferably lift the `insideRadulfSandbox` predicate out of
   `src/server/sandbox/srt.test.ts` into a shared helper under `src/testUtils/`
   (e.g. `src/testUtils/insideRadulfSandbox.ts`) and import it from both files,
   so the documented signal lives in one place. On a plain host the predicate
   is false and the test runs exactly as before.
2. Make the mock hygiene robust so a leaked `Once` can never poison later tests
   again: in each `beforeEach` that currently does `vi.clearAllMocks()` and then
   `mocks.runHarness.mockResolvedValue(...)` (lines ~232–239, ~524–531,
   ~672–679), call `mocks.runHarness.mockReset()` before re-establishing the
   default resolved value (`mockReset` drops the once-queue; `clearAllMocks`
   does not). Additionally, have the Phase 18.1 test assert
   `expect(mocks.runHarness).toHaveBeenCalledTimes(1)` so that on a plain host
   it proves the run went through the harness, and any future environment where
   preflight fails makes *that* test fail loudly instead of silently leaking.

**Verify:** `node_modules/.bin/vitest run src/server/evaluationService.test.ts`
exits 0 inside the sandbox (24 passed, or 23 passed + 1 skipped), then run
`make test` once inside the sandbox with `TMPDIR` untouched and confirm
`Test Files … 0 failed`. Do not run the full suite more than twice.

## What I verified (all pass)

- `grep -rnE '(mkdtempSync|…|readFileSync)\(\s*"/tmp' src` → no output, exit 1.
- `grep -rn 'const scratch = "/tmp' src` → exit 1; `grep -rn '"/tmp/nonexistent-ralph-test-path' src` → exit 1.
- `grep -c 'os.tmpdir()' src/server/bookkeeping.test.ts` → `2`; the index/streamLiveness/git `os.tmpdir()` greps → exit 0.
- Every remaining `"/tmp…` in test files is a string-only fixture (DB rows, mock args, `buildCommandPrefix` argument) — allowed by the card.
- `vitest run bookkeeping/git/harness index/streamLiveness` → 4 files, 79 tests passed, exit 0 with `TMPDIR=/tmp/claude` as the sandbox set it.
- `grep -q 'GIT_SSH_COMMAND === "/bin/false"' srt.test.ts` → exit 0; `^describeOnHost(` count 3; `^describe(` count 11.
- `vitest run src/server/sandbox/srt.test.ts` → exit 0, 26 passed / 21 skipped; verbose reporter confirms the skipped set is exactly preflight (3) + real sandboxed process (7) + acceptance table (11).
- `vitest run srt.test.ts -t "CLAUDE_CODE_TMPDIR"` → 2 tests ran and passed.
- `CLAUDE_CODE_TMPDIR` set at srt.ts:566 and restored at 570–571 inside `wrapUnderPolicy`'s serialized window, in `finally` before `releaseMyTurn()`.
- Call sites: gate.ts, installGate.ts, acceptanceProbe.ts pass `{ tmpdir: ctx.tmpdir }`; pi.ts passes `{ tmpdir: runContext.tmpdir }`. A grep for all non-test `runSandboxedCommand(`/`createSandboxedBashOperations(` callers shows none missed.
- Checked srt internals in `node_modules/@anthropic-ai/sandbox-runtime`: `generateProxyEnvVars` reads `process.env.CLAUDE_CODE_TMPDIR` per wrap (called from `linux-sandbox-utils.js:1459` inside the wrap path) and exports `SANDBOX_RUNTIME=1`; the run `tmpdir` is already in `allowWrite` (srt.ts:226). The design is sound.
- `docs/SANDBOXING.md` mentions `CLAUDE_CODE_TMPDIR`.
- `tsc --noEmit` → exit 0; `eslint` on the listed paths → exit 0.
- `vitest run gate/installGate/acceptanceProbe/pi/sandbox tests` → 70 passed, exit 0.
- Repository gate (`make lint typecheck build check-split`) exit 0 per `.ralph/GATE.md`.

## Notes for the human reviewer (not defects)

- In the real sandbox `GIT_SSH_COMMAND` is srt's socat `ProxyCommand`, not
  `/bin/false` (srt overwrites the agent env value when network policy is on), so
  the half of the signal that actually fires is `SANDBOX_RUNTIME === "1"`. The
  loop documented this in the test comment; the `/bin/false` check is only a
  fallback when network policy is off. The card said "pick one signal" — two
  are used, with a stated reason; I did not count this against the change.
- The `wrapUnderPolicy` restore path runs even when `tmpdir` is undefined
  (harmless no-op reassignment).

```findings
[
  { "severity": "critical", "file": "src/server/evaluationService.test.ts", "line": 487, "issue": "Card criterion 'make test passes inside a Radulf run' fails: the sandboxEnabled=true Phase 18.1 test cannot start a nested sandbox, never consumes its mockImplementationOnce, and the leaked Once (not cleared by vi.clearAllMocks) shifts later mocks, failing 3 tests at lines 651/664/732 — pre-existing on beta but in this card's scope (test-only, nested-sandbox class)." },
  { "severity": "important", "file": "src/server/evaluationService.test.ts", "line": 238, "issue": "beforeEach uses vi.clearAllMocks() then mockResolvedValue; clearAllMocks does not drop queued Once implementations, so any test that fails to consume one poisons the next test — use mocks.runHarness.mockReset() before re-establishing the default." },
  { "severity": "suggestion", "file": "src/server/sandbox/srt.test.ts", "line": 37, "issue": "insideRadulfSandbox predicate is a general test utility; lift it to src/testUtils/ so evaluationService.test.ts (and future tests) share the single documented signal." }
]
```
