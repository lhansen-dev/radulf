# Repository gate

Command: `make lint typecheck build check-split`
Result: exit 2
Duration: 11s
Ran at: 2026-09-24T14:47:50.677Z

## Output, last 8000 characters

```
node_modules/.bin/eslint

/var/lib/radulf/worktrees/let-an-epic-s-pieces-declare-dependencie-B2ggUuar6O_epgY9AZLgA/src/app/card/[id]/breakdownEditor.tsx
  43:22  warning  '_drop' is assigned a value but never used  @typescript-eslint/no-unused-vars

✖ 1 problem (0 errors, 1 warning)

node_modules/.bin/tsc --noEmit
node_modules/.bin/esbuild src/worker.ts --bundle --platform=node --target=node22 --format=esm --packages=external --outfile=dist/worker.mjs --log-level=warning
NODE_ENV=production node_modules/.bin/next build
▲ Next.js 16.3.4 (Turbopack)
✓ Running next.config.ts took 16ms
Attention: Next.js now collects completely anonymous telemetry regarding usage.
This information is used to shape Next.js' roadmap and prioritize features.
You can learn more, including how to opt-out if you'd not like to participate in this anonymous program, by visiting the following URL:
https://nextjs.org/telemetry


  Creating an optimized production build ...

-----
[1m[31mFATAL[39m[0m: An unexpected Turbopack error occurred. A panic log has been written to /tmp/claude/next-panic-6340f2c92353ed09f54260d9fcf28164.log.

To help make Turbopack better, report this error by clicking here: https://bugs.nextjs.org/search?category=turbopack-error-report&title=Turbopack%20Error%3A%20Symlink%20%5Bproject%5D%2Fnode_modules%20is%20invalid%2C%20it%20points%20out%20of%20the%20filesystem%20root&body=Turbopack%20version%3A%20%60299180d3%60%0ANext.js%20version%3A%20%600.0.0%60%0A%0AError%20message%3A%0A%60%60%60%0ASymlink%20%5Bproject%5D%2Fnode_modules%20is%20invalid%2C%20it%20points%20out%20of%20the%20filesystem%20root%0A%0ADebug%20info%3A%0A-%20Execution%20of%20get_all_written_entrypoints_with_issues_operation%20failed%0A-%20Execution%20of%20EntrypointsOperation%3A%3Anew%20failed%0A-%20Execution%20of%20all_entrypoints_write_to_disk_operation%20failed%0A-%20Execution%20of%20output_assets_operation%20failed%0A-%20Execution%20of%20Project%3A%3Aget_all_endpoint_groups_with_app_route_filter%20failed%0A-%20Execution%20of%20Project%3A%3Aentrypoints_with_app_route_filter%20failed%0A-%20Execution%20of%20AppProject%3A%3Aroutes_with_filter%20failed%0A-%20Execution%20of%20directory_tree_to_entrypoints_internal%20failed%0A-%20Execution%20of%20directory_tree_to_loader_tree%20failed%0A-%20Execution%20of%20try_get_next_package%20failed%0A-%20Execution%20of%20resolve%20failed%0A-%20Execution%20of%20resolve_internal%20failed%0A-%20Execution%20of%20find_package%20failed%0A-%20Symlink%20%5Bproject%5D%2Fnode_modules%20is%20invalid%2C%20it%20points%20out%20of%20the%20filesystem%20root%0A%60%60%60&labels=Turbopack,Turbopack%20Panic%20Backtrace
-----


> Build error occurred
Error [TurbopackInternalError]: Symlink [project]/node_modules is invalid, it points out of the filesystem root

Debug info:
- Execution of get_all_written_entrypoints_with_issues_operation failed
- Execution of EntrypointsOperation::new failed
- Execution of all_entrypoints_write_to_disk_operation failed
- Execution of output_assets_operation failed
- Execution of Project::get_all_endpoint_groups_with_app_route_filter failed
- Execution of Project::entrypoints_with_app_route_filter failed
- Execution of AppProject::routes_with_filter failed
- Execution of directory_tree_to_entrypoints_internal failed
- Execution of directory_tree_to_loader_tree failed
- Execution of try_get_next_package failed
- Execution of resolve failed
- Execution of resolve_internal failed
- Execution of find_package failed
- Symlink [project]/node_modules is invalid, it points out of the filesystem root
    at ignore-listed frames {
  type: 'TurbopackInternalError',
  location: undefined
}
make: *** [Makefile:61: build] Error 1
```
