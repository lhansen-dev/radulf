# Repository gate

Command: `make check`
Result: exit 0
Duration: 51s
Ran at: 2026-09-25T23:38:30.850Z

## Output, last 8000 characters

```
…rees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/sandbox/srt.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/stage.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/orchestrator.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/app/api/repos/[id]/route.ts


./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/docs.ts:173:15
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
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/docs.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/app/docs/[slug]/page.tsx

  App Route:
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/docs.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/sandbox/srt.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/stage.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/orchestrator.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/app/api/repos/[id]/route.ts


./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/sandbox/srt.ts:73:16
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
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/sandbox/srt.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/boot.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/instrumentation.ts

  #2 [App Route]:
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/sandbox/srt.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/harness/pi.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/providers.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/app/api/providers/[provider]/models/route.ts

  #3 [App Route]:
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/sandbox/srt.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/sandbox/srt.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/stage.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/orchestrator.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/app/api/repos/[id]/route.ts


./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/transcriptWatchers.ts:80:31
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
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/transcriptWatchers.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/boot.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/instrumentation.ts

  App Route:
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/transcriptWatchers.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/sandbox/srt.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/stage.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/server/orchestrator.ts
    ./var/lib/radulf/worktrees/probe-acceptance-checks-against-the-unto-95iU3Nvw2XunE1BVXyVnL/src/app/api/repos/[id]/route.ts


(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is planned to become the default in a future major version of Vite:
  - ESM syntax in a file loaded as CommonJS (vitest.config.ts:1:1). Use a `.mjs` extension or set `"type": "module"` in the closest package.json
Set `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` to suppress this warning.
```
