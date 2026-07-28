# 13 — One harness: pi in SDK mode, every provider

Supersedes the core premise of [09](09-multi-harness.md) ("the harness follows
the provider") and amends [12](12-pi-harness.md). Pi won spec 11's Phase 3
benchmark decisively on the proxied pair, so this spec finishes the
consolidation the benchmark authorized: **pi is the only harness, it runs
in-process through the `@earendil-works/pi-coding-agent` SDK instead of a CLI
subprocess, and it serves all four providers — including the Anthropic and
ChatGPT subscription paths that spec 09 kept on `claude -p` / `codex exec`.**

Two things this spec treats as settled inputs, both user determinations of
2026-07-17:

1. **The benchmark result.** Pi beat opencode "by a mile" on the Phase 3
   corpus. Spec 12's rollout step 3 promised the proxied default flips on a
   benchmark win; this spec takes the further step of retiring the other two
   harnesses on the same evidence plus the maintenance-simplification tradeoff
   spec 11's promotion bar explicitly allows.
2. **The auth premise reversal.** Spec 09's entire shape rests on "Anthropic
   locks subscription OAuth to first-party clients, so only `claude -p` may use
   the Claude subscription" (decision 4). The user has determined that Anthropic
   now permits subscription use through pi (subscription credits), and that the
   ChatGPT subscription was never restricted this way. This spec records that as
   the user's call and builds on it; it is the load-bearing assumption behind
   decree #2, so if it is ever retracted, this spec's subscription mapping
   reverts with it.

## Why collapse to one harness

Spec 09 shipped three harnesses because each provider needed its native auth or
its own model-agnostic config. Both reasons are now gone:

- **The proxied path already proved pi is leaner and faster.** That was the
  whole Phase 3 question, and it answered yes.
- **Subscription auth is no longer first-party-locked** (input #2), so the only
  reason `claude-code` and `codex` survived — they were the *only* clients
  allowed to hold the subscription tokens — no longer holds. Pi's own login
  supports Claude Pro/Max and ChatGPT/OpenAI.

One harness is the end state the memory-file posture has been pointing at all
along: one code path, no adapter polymorphism kept alive for a single
implementation, no per-provider harness branch. This spec **deletes** the
`RunnerAdapter` seam rather than adding a fourth case to it.

## Why SDK mode over the CLI

With exactly one harness, the CLI's one virtue — being the common denominator
that made three unlike tools present an identical `spawn() → normalize(line)`
seam — has nothing left to unify. The seam's reason to exist dies with the
consolidation, and the SDK becomes strictly better on the axes that remain:

- **Typed events, no JSONL round-trip.** `session.subscribe(listener)` delivers
  event objects directly; the normalizer stops parsing strings and the
  `t:"raw"` string-fallback becomes an object-shape fallback.
- **First-class config, no flag surface to drift.** `tools` / `noTools`,
  `systemPromptOverride`, in-memory settings, and the thinking level are SDK
  options, not CLI flags on a 244-release binary. Spec 12's headline risk
  ("fast release cadence → flag/format drift") is retired for the parts that
  become API calls; version is pinned to one npm dependency.
- **Version is the package version.** `harnessVersion` reads the installed
  `@earendil-works/pi-coding-agent` version instead of shelling out to
  `pi --version`.

The cost SDK mode introduces — losing the subprocess as an isolation boundary —
is real and is handled head-on in **Security** below; it is the one place this
consolidation makes containment *harder*, and the spec pays for it explicitly
rather than pretending it away.

## Scope

Every provider, one harness, in-process:

| Provider | Harness today | Harness after this spec | Auth after this spec |
|----------|---------------|-------------------------|----------------------|
| `anthropic` | claude-code (`claude -p`) | **pi (SDK)** | pi Claude Pro/Max login (subscription credits) |
| `chatgpt` | codex (`codex exec`) | **pi (SDK)** | pi ChatGPT/OpenAI login |
| `omlx` | pi (CLI) | **pi (SDK)** | `models.json`, API key optional |
| `openrouter` | pi (CLI) | **pi (SDK)** | `OPENROUTER_API_KEY` via runtime override |

`PlanRunner`, `PMRunner`, the evaluator, and the summarizer all reach the model
through the same runner, so this change carries every agent role onto pi at once
— including the frontier planner, which decision 3 keeps on the subscription
(now served by pi rather than `claude -p`).

## The pi runner (SDK)

The `RunnerAdapter` / `RunnerSpawn` / `adapterFor` / `HarnessId`-union
machinery in `src/server/harness/` is replaced by a single runner module. There
is no provider switch selecting an implementation — there is one implementation
that is *configured* per provider.

### Session construction

```ts
type PiProvider = "anthropic" | "chatgpt" | "omlx" | "openrouter";

const { session } = await createAgentSession({
  cwd: worktree,
  modelRuntime,                        // shared, points at the Radulf pi dir
  provider,                            // the PiProvider
  model,                               // concrete id (blank rules below)
  thinkingLevel: reasoningLevel,       // per-agent --thinking, now universal
  tools: readOnly ? ["read", "grep", "find", "ls"] : undefined, // undefined = built-in set
  noTools: undefined,                  // never "all"/"builtin" on a work run
  resourceLoader: new DefaultResourceLoader({
    systemPromptOverride: () => RALPH_SYSTEM_PROMPT,
  }),
  settingsManager: SettingsManager.inMemory(),  // no user .pi/settings.json influence
});
```

- **Built-in tool set = the Ralph set** (`read, bash, edit, write, grep, find,
  ls`) on a work run; no `tools` argument. Read-only (chat) runs pass the
  restricted list. This is the SDK analog of spec 12's "no `--tools` in the
  normal spawn".
- **`systemPromptOverride`** replaces pi's default prompt with the same
  one-liner the CLI passed via `--system-prompt`; behavior still lives in
  `.ralph/PROMPT.md`, unchanged.
- **`SettingsManager.inMemory()`** is the reproducible-context lever — the
  documented analog of `--no-extensions --no-skills --no-prompt-templates
  --no-themes --no-approve`: nothing user- or repo-injected. Confirm against the
  SDK that inMemory settings also suppress project-local `.pi/` discovery
  (checklist #5).

### Config isolation and subscription auth — the one real divergence from 12

Spec 12 pointed `PI_CODING_AGENT_DIR` at a **per-run ephemeral** dir so the
user's global `~/.pi/agent` never influenced a run. That is incompatible with
decree #2: **subscription OAuth must persist across runs.** A per-run dir would
throw the login away every iteration.

Resolution: the isolation target was never "ephemeral for its own sake" — it was
"not the user's personal `~/.pi`". So the runner uses **one Radulf-owned,
persistent pi agent dir** under the app data dir (e.g. `data/pi-agent/`),
constructed once and shared by every run via a single long-lived
`ModelRuntime.create({ agentDir })`:

- `auth.json` in that dir holds the pi logins for `anthropic` (Claude Pro/Max)
  and `chatgpt` (OpenAI). The user establishes these once via pi's interactive
  login pointed at the Radulf dir; the claude/codex CLIs are never invoked and
  need not be installed.
- `models.json` in the same dir carries the `omlx` custom-provider block
  (`buildPiModelsJson`, unchanged shape from spec 12: `anthropic-messages`, with
  `openai-completions` the documented fallback). Regenerated when oMLX settings
  change, not per run.
- `openrouter` still travels as a runtime key, not a file:
  `modelRuntime.setRuntimeApiKey("openrouter", settings.openrouterApiKey)` (the
  in-process analog of the old `OPENROUTER_API_KEY` env injection).

Reproducibility of *context* (no user extensions/skills/prompt-templates/themes)
is now enforced by the SDK options above, not by an empty dir — so a persistent
dir holding only auth + models config does not reintroduce the leakage spec 12
guarded against. This is the deliberate, load-bearing narrowing of 12's "per-run
isolation": **isolate from the user's personal config, persist the app's own
auth.**

### Blank-model rules

Unchanged in intent from 12, now applied through the SDK:

- `openrouter` and `omlx` still throw on a blank model (a blank would resolve
  pi's own default, wrong for both).
- `anthropic` / `chatgpt`: blank means "the subscription's default model", the
  same latitude `claude -p` / `codex exec` had. `ModelRuntime.getModel` resolves
  it; pin the exact blank-model behavior per subscription provider (checklist
  #2).

## Execution model rewrite

`runHarnessOnce`'s subprocess machinery — `spawn`, the `detached` process-group
kill, stdout line-buffering, `child.stdout.on("data")` — is removed. The runner
now drives one in-process session:

```ts
const totals = createTranscriptTotals();
const unsubscribe = session.subscribe((evt) => {
  resetStallTimer();
  for (const e of piNormalize(evt)) {
    appendTranscript(e);
    foldTranscriptEvent(totals, e);
    if (firstTokenMs === null && e.t !== "raw") firstTokenMs = elapsed();
  }
});
try {
  await runWithLimits(session.prompt(opts.prompt), {
    timeoutMs, stallTimeoutMs, signal,
  });
} finally {
  unsubscribe();
  await session.dispose();
}
```

The three watchdogs survive, re-expressed for a promise instead of a child:

- **Timeout / abort:** race `session.prompt()` against the iteration timeout and
  `opts.signal`. On expiry, cancel the session (pin the SDK's interrupt/abort
  entry point — `dispose()` at minimum, a cooperative abort if the SDK exposes
  one; checklist #4) instead of `process.kill(-pid)`.
- **Stall watchdog:** reset on each streamed event rather than on each stdout
  chunk; same `stallTimeoutSeconds` semantics. Note the consequence: pi streams
  `thinking_delta` inside `message_update`, so a model that is merely slow keeps
  resetting the timer. The watchdog detects dead streams, never slow ones.
- **`firstTokenMs` / totals:** `foldTranscriptEvent` and `createTranscriptTotals`
  are unchanged — they already operate on normalized `TranscriptEvent`s, which
  is exactly what the subscribe handler produces.

`RunnerResult` keeps its shape (spec 11 Phase 0 telemetry). `harness` collapses
to the constant `"pi"`; the `HarnessId` union becomes the single literal
`"pi"` — kept as a field, not deleted, so the per-iteration telemetry column and
its migration stay stable. The `chatgpt` blank-model retry
(`isUnavailableCodexModelError`) is deleted with the codex adapter.

## Normalization

`piNormalize` keeps its event-type mapping (spec 12's table stands:
`message_end` → text/tool/usage, `stopReason error|aborted` → failed result,
`auto_retry_end success:false` → failed result, deltas and lifecycle framing
dropped, everything else preserved). Two edits:

- Its input is now the SDK event **object**, not a JSONL string — drop the
  `JSON.parse` and the parse-failure `t:"raw"` branch; the "unknown shape"
  fallback still emits `t:"raw"` with a stringified line so nothing is lost.
- Re-pin field names against the SDK's emitted event types (`packages/ai`
  types), not `docs/json.md` — the CLI's `--mode json` framing and the SDK's
  event objects may name or nest fields differently (checklist #1).

`TranscriptEvent`, the transcript files, the SSE feed, the In Review viewer, and
the DB mirroring are **untouched** — the UI still never learns which harness ran
(there is only one now).

## Security — in-process env isolation (must-fix)

This is the one regression the SDK introduces and it is not optional to handle.
In CLI mode the pi subprocess ran with a **scrubbed** env (`agentEnv()` strips
`RADULF_AUTH_SECRET`, `RADULF_AUTH_PASSWORD_HASH`, `OPENROUTER_API_KEY`), so the
agent's `bash` tool structurally could not read Radulf's own secrets — which
matters acutely because Radulf runs cards against its *own* repo.

In SDK mode pi runs inside the Radulf Next.js process, where `process.env` **does**
contain those secrets. If pi's `bash` tool inherits `process.env`, an agent can
read the session-forging secret and the password hash. That is a real
privilege escalation and the spec does not ship without closing it. Options, in
preference order:

1. **Scrubbed shell env via the SDK** — if `createAgentSession` / the bash tool
   accepts an env override, pass `agentEnv()`. Pin whether it does (checklist
   #6). Preferred: minimal, local.
2. **Never put those secrets in `process.env`** — read `RADULF_AUTH_SECRET` /
   `RADULF_AUTH_PASSWORD_HASH` from a file or a module the agent's cwd can't
   reach, so `process.env` is safe to inherit. Larger blast radius (touches
   auth/session code) but removes the class of leak entirely.
3. **Run the session in a worker thread with a scrubbed env** — restores a hard
   boundary, closest to the old subprocess guarantee, and doubles as
   crash-isolation (below). Heaviest; hold unless 1 and 2 prove insufficient.

Whichever lands, the acceptance test is explicit: an agent instructed to
`echo $RADULF_AUTH_SECRET` (and to read the password hash) in a work run sees
nothing.

**Amended by [14-sandboxing.md](14-sandboxing.md):** option 1 shipped, then
hardened three ways. `agentEnv()` inverted from a three-item denylist to a
minimal allowlist (`PATH`, `HOME`, `TMPDIR`, `LANG`/`LC_*`, `TERM=dumb`, git
and package-manager vars, srt's proxy vars) — an unknown secret in the
launching shell now stops leaking by default instead of by enumeration. The
custom bash tool's spawn hook, which swapped only `env` here, now also
srt-wraps the command itself (via a custom `BashOperations.exec`, since the
hook itself is synchronous and the wrap is async — see spec 14 Phase 6),
adding kernel-level filesystem and network containment on top of the env
scrub. And `web_search` — the one network-capable custom tool — moved to
planner-only: the loop and evaluator, which hold `bash`, never hold a
network primitive outside the sandbox's own proxy, keeping the two
dangerous primitives (command execution, network egress) out of the same
role.

## Model listing & preflight

`listProviderModels` / `preflightProvider` currently branch per provider —
`listClaudeCliModels()` (claude CLI cache), `listCodexModels()` (`~/.codex`
cache), and HTTP for oMLX/OpenRouter. With the CLIs gone, model discovery moves
to pi's `ModelRuntime`:

- `modelRuntime.getAvailable()` returns the authenticated models across every
  logged-in provider — one source for the pickers, deleting the CLI-cache
  helpers and their install dependency. Pin its shape and confirm it covers all
  four providers (checklist #3).
- oMLX keeps its live `/v1/models` HTTP list (it isn't a pi-authenticated
  provider, just a `models.json` endpoint) unless `getAvailable()` surfaces it
  from the custom-provider block.
- `preflightProvider` becomes "`ModelRuntime` resolves `provider`+`model` and it
  appears in `getAvailable()`", harness-uniform.

## Reasoning level goes universal

`{planner,loop,evaluator,summarizer}ReasoningLevel` were pi-only and ignored on
the Anthropic/Codex paths. With one harness they apply to every provider via the
session's thinking level. Update the settings copy that says "the
Anthropic/Codex paths ignore these" — nothing ignores them now. Pi still clamps
an unsupported level to the nearest the chosen model honors.

## Amendments to prior specs and locked decisions

- **Decision 3 (planning on subscription, no raw API key):** stands — the
  planner still runs on the Anthropic subscription. What changes is the *client*
  holding the token: pi, not `claude -p`. No raw API key is introduced for the
  subscription path; the subscription is used through pi's sanctioned login
  (input #2).
- **Decision 4 (loop agent = the provider's harness):** re-amended. Previously
  "claude-code for subscription, opencode/pi for proxied". Now: **one harness,
  pi (SDK), for every provider.** The "subscription OAuth is first-party-only"
  clause is struck per input #2.
- **Decision 7 (skip-permissions posture):** re-amended. Pi has no permission
  system; the posture is structural (worktree cwd + prompt guardrails), the
  classic-Ralph stance spec 12 already adopted. The `claude -p
  --dangerously-skip-permissions` / `opencode --auto` phrasings are historical.
- **Spec 09:** its premise ("the harness follows the provider") is superseded;
  its opencode adapter section was already dead code before this spec (pi
  replaced it) and is fully retired here.
- **Spec 12:** amended — pi is no longer a proxied-only candidate behind
  `proxiedHarness` (that toggle was never shipped; the code already defaulted
  every proxied run to pi). Mode changes CLI → SDK; the per-run ephemeral
  `PI_CODING_AGENT_DIR` becomes the persistent Radulf-owned agent dir; the
  normalizer maps SDK objects, not JSONL lines.
- **Spec 11:** the Phase 0 `harness` telemetry dimension is now constant `"pi"`;
  the Phase 3 harness matrix is closed (pi won). Everything else in 11 (token
  accuracy, stall watchdog, iteration caps) is harness-independent and stands.

Doc reconciliation done alongside the code: spec 00 index row + decisions 3/4/7
notes; spec 02 runner-contract and process-model paragraphs (in-process session,
no subprocess); spec 04 loop-invocation line; README prerequisites (drop
claude/codex/opencode CLI requirements; add the pi SDK + a one-time
`pi login` per subscription provider).

## Rollout

1. Land the SDK runner behind the existing settings with `anthropic`/`chatgpt`
   still mappable to the old CLIs **only** long enough to prove the SDK path per
   role — then delete the CLI adapters. No permanent toggle (memory posture: one
   code path, delete the losing option).
2. Establish the two subscription logins in the Radulf pi dir; verify a frontier
   planner run and a loop run each complete through pi on the subscription.
3. Close the **Security** item (agent cannot read Radulf secrets) before any run
   touches Radulf's own repo — this gates self-improvement cards specifically.
   **Amended by [14-sandboxing.md](14-sandboxing.md):** the gate was upgraded
   from "env isolation" to "spec 14's acceptance tests + positive control pass,"
   and is now **satisfied (2026-07-22)** — self-improvement cards are routine
   (spec 14 rollout step 7).
4. Re-pin the normalizer against live SDK event objects (checklist #1); delete
   `claudeCode.ts`, `codex.ts`, `listClaudeCliModels`, `listCodexModels`, the
   `RunnerAdapter` seam, and the subprocess machinery in `index.ts`.

## Non-goals

- A permanent multi-harness fallback — the CLI adapters exist during rollout
  step 1 only, then go.
- Pi extensions, skills, packages, sessions, RPC mode — still the narrowest
  non-interactive surface (unchanged from 12).
- Changing the subscription economics — decision 3's "frontier on the
  subscription" stands; only the client changes.
- A worker-thread sandbox as the default — considered for env/crash isolation
  (Security option 3) but deferred unless options 1–2 prove insufficient.

## Verification checklist

Pin against the installed `@earendil-works/pi-coding-agent` SDK before deleting
the CLI adapters:

1. **Event object shapes** — `message_end` (text/tool/usage), the retry and
   error events, and their field names/nesting as the SDK *emits objects*
   (`packages/ai` types), not as `docs/json.md` frames the CLI stream; adjust
   `piNormalize` and its fixtures to captured objects.
2. **Subscription blank-model** — `ModelRuntime.getModel("anthropic"|"chatgpt")`
   with a blank id resolves the subscription default and completes a run.
3. **`getAvailable()`** — returns authenticated models for all four providers in
   one call; shape suits the pickers; oMLX handled (custom-provider vs. live
   HTTP).
4. **Interrupt/abort** — the SDK entry point that stops an in-flight
   `session.prompt()` for the timeout, stall, and `AbortSignal` paths; confirm
   `dispose()` releases everything and no run leaks a session.
5. **Context reproducibility** — `SettingsManager.inMemory()` +
   `systemPromptOverride` + built-in tools suppress all project-local `.pi/` and
   user-global discovery (extensions, skills, prompt templates, themes).
6. **Env isolation (must-pass)** — the agent's `bash` tool cannot read
   `RADULF_AUTH_SECRET` / `RADULF_AUTH_PASSWORD_HASH`; whichever Security option
   lands, the `echo $RADULF_AUTH_SECRET` test returns nothing.
7. **Persistent auth dir** — the Radulf pi dir keeps both subscription logins
   across process restarts; a populated user `~/.pi/agent` has zero effect on a
   run.

## Risks

| Risk | Mitigation |
|------|-----------|
| **In-process secret exposure** via pi's bash tool inheriting `process.env` | The Security section is a ship gate: scrubbed shell env (opt 1), secrets out of `process.env` (opt 2), or worker-thread sandbox (opt 3); checklist #6 must pass before self-improvement runs |
| A crash/OOM in the in-process SDK takes down the Radulf server (a subprocess couldn't) | Wrap session lifecycle in try/finally with guaranteed `dispose()`; worker-thread sandbox (Security opt 3) is the escalation if crashes surface in practice |
| SDK internal API churn (createAgentSession/ModelRuntime/SettingsManager) across pi's fast release cadence | Pin the npm version in README; the runner isolates the surface to one module; rerun the checklist on upgrade — net *smaller* than the CLI flag-drift surface it replaces |
| The auth-premise reversal (input #2) is wrong or retracted | Subscription mapping is isolated to two provider cases; reverting to `claude -p` / `codex exec` for those two is a contained change, and decision 4's struck clause is restorable |
| SDK event objects diverge from the CLI JSONL mapping | `piNormalize` owns the mapping; the `t:"raw"` fallback still never drops data; checklist #1 re-pins against live objects |
| Losing the subprocess loses a hard interrupt (`kill -9` a hung child) | Checklist #4 pins the SDK abort path; the stall + iteration-timeout watchdogs still fire; worker-thread sandbox restores a killable boundary if needed |
