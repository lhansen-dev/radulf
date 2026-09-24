# Repository gate

Command: `make lint typecheck build check-split`
Result: exit 2
Duration: 2m 25s
Ran at: 2026-09-24T15:20:20.953Z

## Output, last 8000 characters

```
…rbopackIgnore: true*/ ...), or
- remove them.

Import traces:
  Server Component:
    ./src/server/docs.ts
    ./src/app/docs/[slug]/page.tsx

  App Route:
    ./src/server/docs.ts
    ./src/server/sandbox/srt.ts
    ./src/server/stage.ts
    ./src/server/orchestrator.ts
    ./src/app/api/settings/route.ts


./src/server/sandbox/srt.ts:73:16
Warning: Dynamic filesystem access causes tracing of the whole project
  [90m71 |[0m     [32m"Library/Application Support/Firefox"[0m,
  [90m72 |[0m     [32m"Library/Cookies"[0m,
[33m[1m>[0m [90m73 |[0m   ].map((p) => path.join([33mHOME[0m, p));
  [90m   |[0m                [33m[1m^^^^^^^^^^^^^^^^^^[0m
  [90m74 |[0m }
  [90m75 |[0m
  [90m76 |[0m [90m/** System + toolchain install roots (spec §L1 read-allow table), per platform. */[0m

Static analysis determined that this filesystem access causes the whole project to be traced and included in the output.
This is usually unintentional and leads to all source files (including the public folder) to be deployed as part of the server code.
This can slow down deployments or lead to failures when size limits are exceeded.
To resolve this, you can
- make sure the path is statically scoped to some subfolder, for example path.join(process.cwd(), 'data', bar), or
- only use them in development, or
- opt out by adding an ignore comment to the highlighted call: path.join(/*turbopackIgnore: true*/ ...), or
- remove them.

Import traces:
  #1 [Instrumentation]:
    ./src/server/sandbox/srt.ts
    ./src/server/boot.ts
    ./src/instrumentation.ts

  #2 [App Route]:
    ./src/server/sandbox/srt.ts
    ./src/server/sandbox/pathGuard.ts
    ./src/server/folderBrowser.ts
    ./src/app/api/folder-browser/route.ts

  #3 [App Route]:
    ./src/server/sandbox/srt.ts
    ./src/server/stage.ts
    ./src/server/orchestrator.ts
    ./src/app/api/reviews/route.ts


./src/server/transcriptWatchers.ts:80:31
Warning: Dynamic filesystem access causes tracing of the whole project
  [90m78 |[0m ....set(runId, {
  [90m79 |[0m ...ion: target.iteration,
[33m[1m>[0m [90m80 |[0m ...startTranscriptPush(path.join(runTranscriptDir(runId), target.file), runId, target.iter...
  [90m   |[0m                        [33m[1m^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^[0m
  [90m81 |[0m ...
  [90m82 |[0m ...
  [90m83 |[0m ...

Static analysis determined that this filesystem access causes the whole project to be traced and included in the output.
This is usually unintentional and leads to all source files (including the public folder) to be deployed as part of the server code.
This can slow down deployments or lead to failures when size limits are exceeded.
To resolve this, you can
- make sure the path is statically scoped to some subfolder, for example path.join(process.cwd(), 'data', bar), or
- only use them in development, or
- opt out by adding an ignore comment to the highlighted call: path.join(/*turbopackIgnore: true*/ ...), or
- remove them.

Import traces:
  Instrumentation:
    ./src/server/transcriptWatchers.ts
    ./src/server/boot.ts
    ./src/instrumentation.ts

  App Route:
    ./src/server/transcriptWatchers.ts
    ./src/server/sandbox/srt.ts
    ./src/server/stage.ts
    ./src/server/orchestrator.ts
    ./src/app/api/settings/route.ts


(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is planned to become the default in a future major version of Vite:
  - ESM syntax in a file loaded as CommonJS (vitest.config.ts:1:1). Use a `.mjs` extension or set `"type": "module"` in the closest package.json
Set `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` to suppress this warning.

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/server/splitProcesses.test.ts > split web/worker processes
Error: timed out after 120000ms waiting for web2 /api/health
--- web ---
▲ Next.js 16.3.4
- Local:         http://127.0.0.1:43567
- Network:       http://127.0.0.1:43567
✓ Ready in 111ms
✓ Running next.config.ts took 27ms
[radulf] roles: web

--- web2 ---
vd._.js:8:29358)
    at Object.get (.next/server/chunks/_123yavd._.js:8:30341)
    at <unknown> (.next/server/chunks/_123yavd._.js:8:36725)
    at f (.next/server/chunks/_123yavd._.js:103:56260)
    at Module.s [as register] (.next/server/chunks/src_1ja8qay._.js:1:127) {
  code: 'SQLITE_BUSY'
}
SqliteError: An error occurred while loading instrumentation hook: database is locked
    at <unknown> (.next/server/chunks/_123yavd._.js:8:29358)
    at Object.get (.next/server/chunks/_123yavd._.js:8:30341)
    at <unknown> (.next/server/chunks/_123yavd._.js:8:36725)
    at f (.next/server/chunks/_123yavd._.js:103:56260)
    at Module.s [as register] (.next/server/chunks/src_1ja8qay._.js:1:127) {
  code: 'SQLITE_BUSY'
}
SqliteError: An error occurred while loading instrumentation hook: database is locked
    at <unknown> (.next/server/chunks/_123yavd._.js:8:29358)
    at Object.get (.next/server/chunks/_123yavd._.js:8:30341)
    at <unknown> (.next/server/chunks/_123yavd._.js:8:36725)
    at f (.next/server/chunks/_123yavd._.js:103:56260)
    at Module.s [as register] (.next/server/chunks/src_1ja8qay._.js:1:127) {
  code: 'SQLITE_BUSY'
}
SqliteError: An error occurred while loading instrumentation hook: database is locked
    at <unknown> (.next/server/chunks/_123yavd._.js:8:29358)
    at Object.get (.next/server/chunks/_123yavd._.js:8:30341)
    at <unknown> (.next/server/chunks/_123yavd._.js:8:36725)
    at f (.next/server/chunks/_123yavd._.js:103:56260)
    at Module.s [as register] (.next/server/chunks/src_1ja8qay._.js:1:127) {
  code: 'SQLITE_BUSY'
}
SqliteError: An error occurred while loading instrumentation hook: database is locked
    at <unknown> (.next/server/chunks/_123yavd._.js:8:29358)
    at Object.get (.next/server/chunks/_123yavd._.js:8:30341)
    at <unknown> (.next/server/chunks/_123yavd._.js:8:36725)
    at f (.next/server/chunks/_123yavd._.js:103:56260)
    at Module.s [as register] (.next/server/chunks/src_1ja8qay._.js:1:127) {
  code: 'SQLITE_BUSY'
}

--- worker ---
[radulf] roles: worker
sysctl: cannot stat /proc/sys/kernel/apparmor_restrict_unprivileged_userns: No such file or directory
[radulf] sandbox preflight failed — every sandboxEnabled run will fail into Needs Attention until this is fixed (or sandboxEnabled is turned off in Settings):
  - sandbox startup failed: listen EPERM: operation not permitted /tmp/claude/srt-mux-569-0.sock
[radulf] retention sweep: {"runsDeleted":0,"eventsDeleted":0,"transcriptEntriesDeleted":0,"worktreesRemoved":0}

--- worker2 ---
[radulf] roles: worker
sysctl: cannot stat /proc/sys/kernel/apparmor_restrict_unprivileged_userns: No such file or directory
[radulf] sandbox preflight failed — every sandboxEnabled run will fail into Needs Attention until this is fixed (or sandboxEnabled is turned off in Settings):
  - sandbox startup failed: listen EPERM: operation not permitted /tmp/claude/srt-mux-570-0.sock

 ❯ Object.get src/db/index.ts:65:0
 ❯ <unknown> src/server/settings.ts:375:18
 ❯ f src/server/boot.ts:24:30
 ❯ <unknown> src/db/index.ts:55:9
 ❯ Object.get src/db/index.ts:65:0
 ❯ <unknown> src/server/settings.ts:375:18
 ❯ f src/server/boot.ts:24:30
 ❯ <unknown> src/db/index.ts:55:9
 ❯ Object.get src/db/index.ts:65:0
 ❯ <unknown> src/server/settings.ts:375:18
 ❯ f src/server/boot.ts:24:30
 ❯ <unknown> src/db/index.ts:55:9
 ❯ Object.get src/db/index.ts:65:0
 ❯ <unknown> src/server/settings.ts:375:18
 ❯ f src/server/boot.ts:24:30
 ❯ <unknown> src/db/index.ts:55:9
 ❯ Object.get src/db/index.ts:65:0
 ❯ <unknown> src/server/settings.ts:375:18
 ❯ f src/server/boot.ts:24:30
 ❯ waitFor src/server/splitProcesses.test.ts:78:9
     76|     await new Promise((r) => setTimeout(r, 250));
     77|   }
     78|   throw new Error(
       |         ^
     79|     `timed out after ${timeoutMs}ms waiting for ${what}\n--- web ---\n…
     80|   );
 ❯ src/server/splitProcesses.test.ts:269:5

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

make: *** [Makefile:93: check-split] Error 1
```
