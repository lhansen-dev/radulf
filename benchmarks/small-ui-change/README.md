# Small UI Change Benchmark Fixture

The **existing-codebase UI fixture** of the Phase 3 corpus. The seed is a
tiny server-rendered task board (`seed/`); the task is to surface each task's
`priority` field as a badge plus a high-priority count in the header — a
small, well-specified rendering change that exercises code navigation in an
existing codebase rather than greenfield building.

The shared runner commits `seed/` into the target repo before the first run
and hard-resets to that baseline between runs:

```bash
node benchmarks/run-benchmark.mjs --fixture small-ui-change \
  --repo my-throwaway-repo --provider <p> --model <loop-model> \
  --planner-model <planner-model> --password <pw>
```

Criteria are machine-checkable with only Node ≥18 (no npm installs): the
seed's `node --test` suite must pass along with badge/count shape checks, and
`src/server.js` / `data.json` must be byte-identical to the seed (enforced by
sha256) since the task is rendering-only.

| File | Description |
|---|---|
| `TASK.md` | Card content fed to the Radulf planner (title + description) |
| `CRITERIA.md` | Machine-checkable acceptance criteria commands |
| `seed/` | Starting codebase committed into the benchmark repo |
