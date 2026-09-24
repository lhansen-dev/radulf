# Repository gate

Command: `make lint typecheck build check-split`
Result: exit 2
Duration: 56s
Ran at: 2026-09-24T15:31:36.567Z

## Output, last 8000 characters

```
…├ ƒ /api/cards/[id]/scoping/split
├ ƒ /api/cards/export
├ ƒ /api/cards/import
├ ƒ /api/events/stream
├ ƒ /api/folder-browser
├ ƒ /api/github/status
├ ƒ /api/health
├ ƒ /api/improvement-runs
├ ƒ /api/improvement-runs/[id]/stop
├ ƒ /api/jira/issue
├ ƒ /api/maintenance/cleanup
├ ƒ /api/provider-login
├ ƒ /api/provider-login/[id]
├ ƒ /api/providers/[provider]/models
├ ƒ /api/providers/usage
├ ƒ /api/repos
├ ƒ /api/repos/[id]
├ ƒ /api/repos/[id]/branches
├ ƒ /api/repos/clone
├ ƒ /api/repos/init
├ ƒ /api/restart
├ ƒ /api/reviews
├ ƒ /api/runs/[id]
├ ƒ /api/schedules
├ ƒ /api/schedules/[id]
├ ƒ /api/settings
├ ƒ /api/settings/prompt-template-defaults
├ ƒ /benchmarks
├ ƒ /card/[id]
├ ƒ /docs
├ ƒ /docs/[slug]
├ ƒ /login
├ ƒ /review/[id]
└ ƒ /settings


ƒ Proxy (Middleware)

ƒ  (Dynamic)  server-rendered on demand

RADULF_SPLIT_CHECK=1 node_modules/.bin/vitest run src/server/splitProcesses.test.ts

 RUN  v4.1.11 /var/lib/radulf/worktrees/sync-a-finished-loop-with-its-base-branc-9ptxkwj-EHX5XccJnG38t

make[1]: Entering directory '/var/lib/radulf/worktrees/sync-a-finished-loop-with-its-base-branc-9ptxkwj-EHX5XccJnG38t'
node_modules/.bin/esbuild src/worker.ts --bundle --platform=node --target=node22 --format=esm --packages=external --outfile=dist/worker.mjs --log-level=warning
make[1]: Leaving directory '/var/lib/radulf/worktrees/sync-a-finished-loop-with-its-base-branc-9ptxkwj-EHX5XccJnG38t'
 ❯ src/server/splitProcesses.test.ts (9 tests | 1 failed) 31041ms
     ✓ both roles boot one fresh data directory at once 18ms
     ✓ fans a card created on one web process out to the other web process's event stream  332ms
     × drives a card from Todo to In Review through the web-only process 3032ms
     ✓ cancelling a looping card from the web-only process ends the run in the worker  1106ms
     ✓ pausing a looping card from the web-only process pauses it at the iteration boundary and resume starts a new claimed run  1381ms
     ✓ two workers never run two runs of one repo at once with a cap of one  2511ms
     ✓ two approvals from two web processes deliver serially and a loop overlapping a sibling merge reports no tampering  1447ms
     ✓ SIGKILL on a worker mid-loop hands the card to the other worker within the stale window  15289ms
     ✓ SIGTERM drains the worker-only process 14ms

 Test Files  1 failed (1)
      Tests  1 failed | 8 passed (9)
   Start at  15:32:01
   Duration  31.17s (transform 40ms, setup 0ms, import 60ms, tests 31.04s, environment 0ms)

Turbopack build encountered 3 warnings:
./src/server/docs.ts:173:15
Warning: Dynamic filesystem access causes tracing of the whole project
  [90m171 |[0m   [36mconst[0m meta = [33mBY_SLUG[0m.get(slug);
  [90m172 |[0m   [36mif[0m (!meta) [36mreturn[0m [36mnull[0m;
[33m[1m>[0m [90m173 |[0m   [36mconst[0m abs = path.join(process.cwd(), meta.sourcePath);
  [90m    |[0m               [33m[1m^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^[0m
  [90m174 |[0m   [36mconst[0m content = stripLayoutHtml([36mawait[0m readFile(abs, [32m"utf8"[0m));
  [90m175 |[0m   [36mreturn[0m { meta, content };
  [90m176 |[0m }

Static analysis determined that this filesystem access causes the whole project to be traced and included in the output.
This is usually unintentional and leads to all source files (including the public folder) to be deployed as part of the server code.
This can slow down deployments or lead to failures when size limits are exceeded.
To resolve this, you can
- make sure the path is statically scoped to some subfolder, for example path.join(process.cwd(), 'data', bar), or
- only use them in development, or
- opt out by adding an ignore comment to the highlighted call: path.join(/*turbopackIgnore: true*/ ...), or
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
    ./src/app/api/cards/[id]/scoping/split/route.ts


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
    ./src/server/harness/pi.ts
    ./src/server/providers.ts
    ./src/app/api/providers/[provider]/models/route.ts


./src/server/transcriptWatchers.ts:79:31
Warning: Dynamic filesystem access causes tracing of the whole project
  [90m77 |[0m ....set(runId, {
  [90m78 |[0m ...ion: target.iteration,
[33m[1m>[0m [90m79 |[0m ...startTranscriptPush(path.join(runTranscriptDir(runId), target.file), runId, target.iter...
  [90m   |[0m                        [33m[1m^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^[0m
  [90m80 |[0m ...
  [90m81 |[0m ...
  [90m82 |[0m ...

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
    ./src/app/api/cards/[id]/scoping/split/route.ts


(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is planned to become the default in a future major version of Vite:
  - ESM syntax in a file loaded as CommonJS (vitest.config.ts:1:1). Use a `.mjs` extension or set `"type": "module"` in the closest package.json
Set `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` to suppress this warning.

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/server/splitProcesses.test.ts > split web/worker processes > drives a card from Todo to In Review through the web-only process
AssertionError: expected 0 to be greater than 0
 ❯ src/server/splitProcesses.test.ts:498:29
    496|         lines: unknown[];
    497|       }>;
    498|       expect(pushes.length).toBeGreaterThan(0);
       |                             ^
    499|
    500|       // Gapless and duplicate-free per iteration.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

make: *** [Makefile:93: check-split] Error 1
```
