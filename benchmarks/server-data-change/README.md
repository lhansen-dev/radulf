# Server / Data Change Benchmark Fixture

The **existing-codebase server fixture** of the Phase 3 corpus. The seed is a
tiny JSON-file-backed notes API (`seed/`) with pure, socket-free request
handlers; the task adds validated `tags` support to `createNote` and tag
filtering to `listNotes` — a typical server/data change with input-validation
edge cases.

The shared runner commits `seed/` into the target repo before the first run
and hard-resets to that baseline between runs:

```bash
node benchmarks/run-benchmark.mjs --fixture server-data-change \
  --repo my-throwaway-repo --provider <p> --model <loop-model> \
  --planner-model <planner-model> --password <pw>
```

Criteria are machine-checkable with only Node ≥18 (no npm installs): the
seed's `node --test` suite must pass along with direct handler checks for tag
creation, validation rejections, defaults, and filtering. `src/server.js` and
`src/store.js` must stay byte-identical to the seed (enforced by sha256) —
the HTTP layer already forwards query params, so the change is handlers-only.

| File | Description |
|---|---|
| `TASK.md` | Card content fed to the Radulf planner (title + description) |
| `CRITERIA.md` | Machine-checkable acceptance criteria commands |
| `seed/` | Starting codebase committed into the benchmark repo |
