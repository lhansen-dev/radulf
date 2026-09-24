# Repository gate

Command: `make check`
Result: exit 2
Duration: 14s
Ran at: 2026-09-24T01:15:54.951Z

## Output, last 8000 characters

```
…'
 ❯ run src/server/harness/index.test.ts:221:8
    219|    * so prompt settles. */
    220|   function run(script: Script, opts: Partial<Parameters<typeof runHarn…
    221|     fs.mkdirSync(scratch, { recursive: true });
       |        ^
    222|     return runHarness({
    223|       provider: "openrouter",
 ❯ src/server/harness/index.test.ts:350:26

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[12/21]⎯

 FAIL  src/server/harness/index.test.ts > runHarness watchdogs > does not report an external abort that lands mid-turn as a failure
Error: ENOENT: no such file or directory, mkdir '/tmp/ralph-stall-test'
 ❯ run src/server/harness/index.test.ts:221:8
    219|    * so prompt settles. */
    220|   function run(script: Script, opts: Partial<Parameters<typeof runHarn…
    221|     fs.mkdirSync(scratch, { recursive: true });
       |        ^
    222|     return runHarness({
    223|       provider: "openrouter",
 ❯ src/server/harness/index.test.ts:369:26

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[13/21]⎯

 FAIL  src/server/harness/index.test.ts > runHarness watchdogs > keeps a genuine pre-abort failure even when the abort follows it
Error: ENOENT: no such file or directory, mkdir '/tmp/ralph-stall-test'
 ❯ run src/server/harness/index.test.ts:221:8
    219|    * so prompt settles. */
    220|   function run(script: Script, opts: Partial<Parameters<typeof runHarn…
    221|     fs.mkdirSync(scratch, { recursive: true });
       |        ^
    222|     return runHarness({
    223|       provider: "openrouter",
 ❯ src/server/harness/index.test.ts:394:26

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[14/21]⎯

 FAIL  src/server/harness/index.test.ts > runHarness watchdogs > surfaces a session-construction failure as an error result
Error: ENOENT: no such file or directory, mkdir '/tmp/ralph-stall-test'
 ❯ run src/server/harness/index.test.ts:221:8
    219|    * so prompt settles. */
    220|   function run(script: Script, opts: Partial<Parameters<typeof runHarn…
    221|     fs.mkdirSync(scratch, { recursive: true });
       |        ^
    222|     return runHarness({
    223|       provider: "openrouter",
 ❯ src/server/harness/index.test.ts:410:26

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[15/21]⎯

 FAIL  src/server/harness/streamLiveness.test.ts > runHarness with a ping-only provider stream > does not stall while only keep-alive comments arrive
Error: ENOENT: no such file or directory, mkdir '/tmp/ralph-liveness-test'
 ❯ src/server/harness/streamLiveness.test.ts:156:8
    154|     // killed at 100ms as "stream hung".
    155|     respond = async () => sseResponse(Array(8).fill(": OPENROUTER PROC…
    156|     fs.mkdirSync(scratch, { recursive: true });
       |        ^
    157|
    158|     const result = await runHarness({

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[16/21]⎯

 FAIL  src/server/harness/streamLiveness.test.ts > runHarness with a ping-only provider stream > still stalls when the stream goes truly silent
Error: ENOENT: no such file or directory, mkdir '/tmp/ralph-liveness-test'
 ❯ src/server/harness/streamLiveness.test.ts:191:8
    189|         { status: 200, headers: { "content-type": "text/event-stream" …
    190|       );
    191|     fs.mkdirSync(scratch, { recursive: true });
       |        ^
    192|
    193|     const result = await runHarness({

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[17/21]⎯

 FAIL  src/server/sandbox/srt.test.ts > sandboxPreflight / initializeSandboxRuntimeOnce (real srt, no mocks) > is idempotent and memoized across calls
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ src/server/sandbox/srt.test.ts:327:22
    325|     const first = await initializeSandboxRuntimeOnce();
    326|     const second = await initializeSandboxRuntimeOnce();
    327|     expect(first.ok).toBe(true);
       |                      ^
    328|     expect(second).toBe(first); // same cached promise resolution, not…
    329|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[18/21]⎯

 FAIL  src/server/sandbox/srt.test.ts > sandboxPreflight / initializeSandboxRuntimeOnce (real srt, no mocks) > fails preflight when dependencies exist but a wrapped command cannot start
AssertionError: expected 'sandbox startup failed: listen EPERM:…' to contain 'apply-seccomp: No such file or direct…'

Expected: "apply-seccomp: No such file or directory"
Received: "sandbox startup failed: listen EPERM: operation not permitted /tmp/claude/srt-mux-46-1.sock"

 ❯ src/server/sandbox/srt.test.ts:340:40
    338|       expect(result.ok).toBe(false);
    339|       expect(result.errors.join("\n")).toContain("sandbox startup fail…
    340|       expect(result.errors.join("\n")).toContain("apply-seccomp: No su…
       |                                        ^
    341|       expect(await initializeSandboxRuntimeOnce()).toBe(result);
    342|       expect(wrap).toHaveBeenCalledTimes(1);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[19/21]⎯

 FAIL  src/server/sandbox/srt.test.ts > runSandboxedCommand / createSandboxedBashOperations (real sandboxed process) > runSandboxedCommand allows a write inside the worktree and denies one outside it
AssertionError: promise resolved "{ stdout: '', stderr: '' }" instead of rejecting

- Expected
+ Received

- Error {
-   "message": "rejected promise",
+ {
+   "stderr": "",
+   "stdout": "",
  }

 ❯ src/server/sandbox/srt.test.ts:422:53
    420|     expect(fs.existsSync(path.join(worktree, "ok.txt"))).toBe(true);
    421|
    422|     await expect(sh(`echo hi > ${outside}/bad.txt`)).rejects.toThrow();
       |                                                     ^
    423|     expect(fs.existsSync(path.join(outside, "bad.txt"))).toBe(false);
    424|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[20/21]⎯

 FAIL  src/server/sandbox/srt.test.ts > acceptance-test table — individual rows verified directly (spec 14 §Acceptance tests) > `curl` to the default-allowed registry.npmjs.org succeeds — regression for the updateConfig bug found by the live positive control
Error: Command failed: /bin/sh -c bwrap --new-session --die-with-parent --unshare-net --ro-bind / / --bind /tmp/claude /tmp/claude --bind /tmp/claude/radulf-accept-wt-wUcnaI /tmp/claude/radulf-accept-wt-wUcnaI --bind /tmp/claude/radulf-accept-wt-wUcnaI /tmp/claude/radulf-accept-wt-wUcnaI --bind /tmp/claude/radulf-accept-wt-wUcnaI /tmp/claude/radulf-accept-wt-wUcnaI --bind /tmp/claude/radulf-accept-repo-3D9No4/.git /tmp/claude/radulf-accept-repo-3D9No4/.git --tmpfs /var/lib/radulf/home --tmpfs /var/lib/radulf/worktrees/fan-out-events-and-live-transcripts-to-e-PAp-ME0O6NmMJkB3yq9BZ/data --ro-bind /tmp/claude/radulf-accept-wt-wUcnaI/.git /tmp/claude/radulf-accept-wt-wUcnaI/.git --ro-bind /tmp/claude/radulf-accept-repo-3D9No4/.git/hooks /tmp/claude/radulf-accept-repo-3D9No4/.git/hooks --ro-bind /tmp/claude/radulf-accept-repo-3D9No4/.git/config /tmp/claude/radulf-accept-repo-3D9No4/.git/config --ro-bind /tmp/claude/radulf-accept-repo-3D9No4/.git/refs /tmp/claude/radulf-accept-repo-3D9No4/.git/refs --ro-bind /tmp/claude/radulf-accept-repo-3D9No4/.git/packed-refs /tmp/claude/radulf-accept-repo-3D9No4/.git/packed-refs --ro-bind /tmp/claude/radulf-accept-repo-3D9No4/.git/HEAD /tmp/claude/radulf-accept-repo-3D9No4/.git/HEAD --ro-bind /tmp/claude/radulf-accept-repo-3D9No4/.git/worktrees/radulf-accept-wt-wUcnaI/config /tmp/claude/radulf-accept-repo-3D9No4/.git/worktrees/radulf-accept-wt-wUcnaI/config --ro-bind /tmp/claude/radulf-accept-repo-3D9No4/.git/worktrees/radulf-accept-wt-wUcnaI/HEAD /tmp/claude/radulf-accept-repo-3D9No4/.git/worktrees/radulf-accept-wt-wUcnaI/HEAD --dev /dev --unshare-pid --unshare-user --cap-drop ALL --proc /proc -- /usr/bin/bash -c '/var/lib/radulf/worktrees/fan-out-events-and-live-transcripts-to-e-PAp-ME0O6NmMJkB3yq9BZ/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp /usr/bin/bash -c '"'"'curl -sS -m 10 -o /dev/null -w '"'"'"'"'"'"'"'"'%{http_code}'"'"'"'"'"'"'"'"' https://registry.npmjs.org/is-odd'"'"''
curl: (7) Failed to connect to localhost port 3128 after 0 ms: Couldn't connect to server

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[21/21]⎯

make: *** [Makefile:84: test] Error 1
```
