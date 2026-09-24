# Evaluator running notes (attempt started 2026-09-24T14:42Z)

Env: inside Radulf sandbox — TMPDIR=/tmp/claude, SANDBOX_RUNTIME=1, /tmp read-only, GIT_SSH_COMMAND is srt's socat ProxyCommand (NOT /bin/false). TMPDIR left untouched.

- grep C1 (fs calls on "/tmp): no output, exit 1 — PASS
- grep C2 (const scratch = "/tmp): no output, exit 1 — PASS
- grep C3 ("/tmp/nonexistent-ralph-test-path): no output, exit 1 — PASS
- grep -c os.tmpdir() bookkeeping.test.ts: 2 — PASS
- grep C5 (index/streamLiveness/git os.tmpdir): exit 0 — PASS
- grep C7 GIT_SSH_COMMAND === "/bin/false" in srt.test.ts: exit 0 — PASS
- grep -c ^describeOnHost( : 3; grep -c ^describe( : 11 — PASS
- grep CLAUDE_CODE_TMPDIR srt.ts: lines 564/566/570/571 set+restore inside wrapUnderPolicy — PASS
- grep C11 call sites gate/installGate/acceptanceProbe/pi: exit 0 — PASS
- grep CLAUDE_CODE_TMPDIR docs/SANDBOXING.md: exit 0 — PASS
- remaining "/tmp in test files are all string-only fixtures (db rows, mock args) — OK
- vitest bookkeeping/git/harness index/streamLiveness: 4 files, 79 tests passed, exit 0 (TMPDIR=/tmp/claude untouched) — PASS
- vitest srt.test.ts: exit 0, 26 passed / 21 skipped; skipped = exactly preflight(3) + real sandboxed process(7) + acceptance table(11) — PASS
- vitest srt.test.ts -t CLAUDE_CODE_TMPDIR: 2 tests ran & passed, exit 0 — PASS
- tsc --noEmit: exit 0 — PASS
- eslint (listed paths): exit 0 — PASS
- vitest gate/installGate/acceptanceProbe/pi/sandbox tests: 70 passed, exit 0 — PASS
- make test (full suite, once, TMPDIR untouched): exit 2 — 3 failed / 1294 passed / 30 skipped; all 3 failures in src/server/evaluationService.test.ts (lines 651, 664, 732)
- evaluationService.test.ts alone: same 3 fail deterministically (3/3 runs)
- git archive beta -> $TMPDIR/eval-beta-check, same test file: SAME 3 failures — pre-existing on beta, not introduced by this change
- bisect with -t: "PLAN.md Phase 18.1 regression … sandboxWeakerIsolationForGoTls" (line 487) + "honours…" reproduces; every other pairing passes → that test leaks a queued mockImplementationOnce
- cause: that test sets sandboxEnabled=true; inside the sandbox initializeSandboxRuntimeOnce() = {ok:false, errors:["sandbox startup failed: listen EPERM … /tmp/claude/srt-mux-*.sock"]} (probe run in the beta export) → runEvaluator takes fail(sandboxError), runHarness never called, Once survives vi.clearAllMocks → shifts later Once mocks by one
- verified srt internals: sandbox-utils.js generateProxyEnvVars reads process.env.CLAUDE_CODE_TMPDIR per wrap (linux-sandbox-utils.js:1459) and exports SANDBOX_RUNTIME=1; run tmpdir is in allowWrite (srt.ts:226) — fix design sound
- all non-test runSandboxedCommand/createSandboxedBashOperations call sites pass tmpdir (gate, installGate, acceptanceProbe, pi) — none missed
- gate (lint typecheck build check-split) exit 0 per .ralph/GATE.md
VERDICT: revise — every private criterion passes, but the card's own criterion #1 (`make test` passes inside the sandbox) does not, for a test-only, in-scope reason.
