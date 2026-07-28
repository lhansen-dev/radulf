# 12 — Pi harness for the proxied providers

Amends [09](09-multi-harness.md) and [11](11-loop-performance.md). This spec
adds [pi](https://github.com/earendil-works/pi) as a fourth loop harness and a
candidate replacement for opencode on the proxied providers (`omlx`,
`openrouter`). The end state it aims at is the leanest harness spec 11 is
otherwise configuring OpenCode into being: a coding agent whose *default*
surface is already the Ralph tool set, with no todo tool, no subagents, no
skills, and no permission ceremony to bypass.

The default does **not** flip in this spec. Pi ships behind a reversible
setting and must win the spec 11 Phase 3 benchmark before it becomes the
proxied default. Spec 11's own rule applies: the measured result, not the
estimate, decides.

## Why pi

Checked against pi v0.80.7 docs on 2026-07-14 (`packages/coding-agent/docs/`):

- **The minimal tool set is the default, not configuration.** Built-in tools
  are exactly `read, bash, edit, write, grep, find, ls`. There is no
  `todowrite` (13.7% of tool calls in spec 11's baseline run, each usually
  forcing an extra model turn), no task/subagent tools, no skills, no
  doom-loop recovery. Spec 11 Phase 1's deny-wildcard permission work exists
  to remove capabilities pi never injects.
- **No permission system matches the Ralph posture.** Spec 09 already ships
  opencode with `--auto` ("dangerous!") because containment is structural
  (worktree + prompt guardrails). Pi's documented stance — no built-in
  permission system, containerize if you need isolation — is the same posture
  stated honestly, with zero flags.
- **The JSON event stream fits the adapter seam.** `--mode json` emits
  newline-delimited events (`message_end`, `tool_execution_*`, `agent_end`,
  …) whose `AssistantMessage.usage` carries `input`, `output`, `cacheRead`,
  `cacheWrite`, optional `reasoning`, and a computed `cost.total` — the exact
  fields spec 11 Phase 0 adds to `UsageEvent`. Today's adapter maps the two
  fields the current `TranscriptEvent` schema has; Phase 0 gets the rest for
  free when it lands.
- **One harness could eventually serve every API-key provider.** OpenRouter is
  a built-in pi provider (`OPENROUTER_API_KEY`); custom OpenAI/Anthropic-style
  endpoints (oMLX) are declared in a `models.json`. That collapses spec 09's
  "flag/format drift × N" risk row toward one pinned dependency.
- **Per-run isolation exists.** `PI_CODING_AGENT_DIR` overrides the config
  directory (default `~/.pi/agent`), the analog of `OPENCODE_CONFIG`: the
  user's global pi settings, extensions, and auth never influence a run.

## Scope

Only the proxied providers, only the LoopRunner path, only behind a setting:

| Provider | Harness today | Harness with `proxiedHarness = "pi"` |
|----------|---------------|--------------------------------------|
| `anthropic` | Claude Code (`claude -p`) | unchanged |
| `chatgpt` | Codex CLI (`codex exec`) | unchanged |
| `omlx` | opencode (`opencode run`) | **pi** (`pi --mode json`) |
| `openrouter` | opencode (`opencode run`) | **pi** (`pi --mode json`) |

The subscription providers are explicitly out of scope. Pi advertises
Claude Pro/Max and ChatGPT login support, but Anthropic locks subscription
OAuth to first-party clients (the reason spec 09 exists in its current shape)
and locked decision 3 forbids the API-key alternative. Same logic as 09:
the subscription path keeps the harness that is allowed to use it.

`adapterFor` grows a settings parameter and the seam a fourth id:

```ts
type HarnessId = "claude-code" | "opencode" | "codex" | "pi";

function adapterFor(provider: ProviderId, s = getSettings()): RunnerAdapter {
  if (provider === "anthropic") return claudeCodeAdapter;
  if (provider === "chatgpt") return codexAdapter;
  return s.proxiedHarness === "pi" ? makePiAdapter(provider, s) : makeOpencodeAdapter(provider, s);
}
```

`proxiedHarness` (settings key, default `"opencode"`) is the independently
reversible switch spec 11's rollout section requires, and doubles as the
experiment-cohort annotation until Phase 0 persists `harness` per iteration.
This narrows 09's non-goal "harness choice as a user-facing setting — it's a
function of provider": it stays a function of provider for the subscription
paths; for the proxied pair it is one experiment toggle, not a per-run picker.

## The pi adapter

Flags verified against pi v0.80.7 docs (`usage.md`, `json.md`, `models.md`,
`providers.md`, `settings.md`):

```
PI_CODING_AGENT_DIR=<runDir>/pi-agent \
  [OPENROUTER_API_KEY=<settings.openrouterApiKey>] \
  pi --mode json --no-session --no-approve \
     --no-extensions --no-skills --no-prompt-templates --no-themes \
     --system-prompt "<ralph one-liner>" \
     --provider <provider> --model <model> \
     "<prompt>"
```

- `--mode json` — JSONL events on stdout; the analog of `stream-json` /
  `--format json`.
- `--no-session` — ephemeral; Radulf's transcript files are the record, and
  fresh context per iteration stays the loop contract.
- `--no-approve` — ignore project-local `.pi/` resources; with
  `--no-extensions --no-skills --no-prompt-templates --no-themes`, this is the
  analog of opencode's `--pure`: reproducible context, nothing user- or
  repo-injected.
- `--system-prompt` — replaces pi's default system prompt with the same
  one-liner the opencode `ralph` agent uses; behavior lives in `.ralph/PROMPT.md`,
  unchanged. This is the token-overhead lever.
- No `--tools` flag in the normal spawn: pi's built-in set *is* the Ralph set.
  Read-only invocations (chat) pass `--tools read,grep,find,ls`.
- No permission flags exist, and none are passed. Skip-permissions posture is
  the harness default.

**Generated config, no global state.** The adapter always points
`PI_CODING_AGENT_DIR` at `<runDir>/pi-agent` (never the worktree — it must not
appear in the card's diff). For `openrouter` the key travels as
`OPENROUTER_API_KEY` (built-in provider). For `omlx` the adapter writes
`<runDir>/pi-agent/models.json`:

```jsonc
{
  "providers": {
    "omlx": {
      "baseUrl": "<settings.omlxBaseUrl>",
      "api": "anthropic-messages",      // oMLX speaks /v1/messages, matching
      "apiKey": "<settings.omlxApiKey || \"omlx\">", // 09's @ai-sdk/anthropic choice;
      "models": [{ "id": "<model>" }]   // openai-completions is the fallback (checklist)
    }
  }
}
```

**Blank-model rules.** OpenRouter fails loudly on a blank model, same as
opencode. **Divergence from 09:** blank is *not* acceptable for `omlx` under
pi — `models.json` needs a concrete model id and pi would otherwise resolve
its own default model, which may not be the oMLX server's. The adapter throws;
the Settings model picker already lists oMLX ids.

### Normalization

Same `TranscriptEvent` contract, fourth normalizer. Mapping pinned against
`docs/json.md` and `packages/ai/src/types.ts` (v0.80.7); live-run pinning is
checklist #1.

| pi event | transcript events |
|----------|-------------------|
| `message_end` (assistant): `content[]` text blocks | `t:"text"` per non-empty block |
| `message_end` (assistant): `content[]` `toolCall` blocks | `t:"tool"` (`name`, `input` = `arguments`) |
| `message_end` (assistant): `usage` | `t:"usage"` (`input` → `inputTokens`, `output` → `outputTokens`) |
| `message_end` with `stopReason` `error`/`aborted` | `t:"result"` failed, detail = `errorMessage` |
| `auto_retry_end` with `success: false` | `t:"result"` failed, detail = `finalError` |
| `message_start` / `message_update` / `turn_start` / `agent_start` / `agent_end` / `tool_execution_start` / `tool_execution_update` | nothing — deltas and lifecycle framing whose content is fully duplicated by `message_end` |
| `tool_execution_end`, session header, everything else | `t:"raw"` — never drop data |

Dropping `message_update` is deliberate and load-bearing: it fires per token
delta and would multiply transcript size for zero information (the full
message arrives in `message_end`). This is the one place the "never drop
data" rule reads as "never drop *data*", not "never drop framing" — the same
judgment the claude-code normalizer already makes by folding streaming into
its aggregate lines.

## Amendments to spec 11

- **Phase 1, minimal tool set:** under pi the deny-list work is structural —
  there is nothing to deny. The Phase 1 acceptance ("adapter tests assert the
  deny-by-default contract") maps to asserting the spawn contract instead: no
  extension/skill discovery flags absent, tool surface = built-ins only.
- **Phase 1, worktree smoke test:** "an attempted write outside the worktree
  is denied" is unenforceable in a harness with no permission system. For the
  pi cohort this requirement is amended to the classic-Ralph posture spec 09
  already accepted for `--auto`: containment is structural (worktree cwd +
  prompt guardrails), and the smoke test instead verifies an ordinary
  edit/test inside the worktree succeeds. If harness-level enforcement is ever
  wanted, a ~20-line pi extension intercepting `tool_call` events can veto
  out-of-worktree writes — deferred until evidence says it's needed.
- **Phase 3 benchmark:** pi joins the candidate matrix as a harness dimension,
  same corpus, same promotion bar (no quality regression, ≥20% median
  accepted-work wall-time improvement — or the maintenance-simplification
  tradeoff explicitly accepted by the user). OpenCode vs pi runs on
  `openrouter` with identical models so the harness is the only variable.
  Watch the cache-hit ratio: pi's smaller fixed context should show up
  directly in the uncached-input bands spec 11 ties to wall time.

## Rollout

1. Adapter + tests land with `proxiedHarness` defaulting to `"opencode"`.
   Nothing changes for any existing run.
2. Live smoke on `openrouter`: one card end-to-end (plan → iterations →
   evaluate → review → merge) with `proxiedHarness = "pi"`, transcript inspected, event
   mapping re-pinned against the live stream (checklist below).
3. After spec 11 Phase 0 telemetry lands, run the Phase 3 corpus
   opencode-vs-pi. Flip the proxied default only on a benchmark win.
4. Revisit the subscription providers only if pi's subscription auth becomes
   unambiguously first-party-sanctioned; until then it is a non-goal.

## Non-goals

- Pi for `anthropic`/`chatgpt` — subscription OAuth is first-party-locked;
  decision 3 forbids the API-key route. Unchanged from 09.
- Flipping the proxied default in this spec — that is a Phase 3 benchmark
  outcome.
- Extending `TranscriptEvent` with cache/cost fields — that is spec 11
  Phase 0, harness-independent, and lands on its own schedule.
- Planner/PM/summarizer — frontier runs on the subscription (locked
  decision 3), untouched. The evaluator role was added later and uses the
  configured provider through the same adapter seam.
- Pi extensions, skills, packages, RPC mode, sessions — the loop uses the
  narrowest non-interactive surface pi has.

## Verification checklist

To pin against live runs before flipping any default:

1. `--mode json` event stream: shapes of `message_end`, `tool_execution_end`,
   `auto_retry_*`, and the session header against a real `openrouter` run;
   adjust the normalizer fixtures to verbatim captured lines.
2. `PI_CODING_AGENT_DIR` fully isolates: a populated `~/.pi/agent` (auth,
   extensions, settings) has zero effect on a run.
3. `models.json` `anthropic-messages` against a live oMLX; fall back to
   `"api": "openai-completions"` on its OpenAI-shaped route if `/v1/messages`
   doesn't slot cleanly (same contingency as 09 checklist #3).
4. `OPENROUTER_API_KEY` via env suffices with `--provider openrouter` — no
   `/login`, no `auth.json`.
5. Non-interactive trust: `--no-approve` produces no prompt and no project
   `.pi` loading in `--mode json`.
6. Exit codes: pi exits non-zero on provider/auth failure so `shouldFallback`
   and the stderr capture in `runHarness` behave as they do for the other
   harnesses.

## Risks

| Risk | Mitigation |
|------|-----------|
| Fast release cadence (v0.80.x, 244 releases) → flag/format drift | Pin the version in README; adapter isolates drift to one file; rerun the checklist on upgrade |
| JSON event schema shifts | Normalizer owns the mapping; `t:"raw"` fallback never loses data; session files (if ever enabled) are a lossless recovery |
| Pi not actually leaner than the stripped opencode agent | That's what the Phase 3 benchmark decides; the toggle reverts in one setting |
| No permission system surprises a future non-classic deployment | The posture is documented here and in 09; containerization is pi's documented answer if the trust model ever changes |
| `models.json` api mismatch for oMLX | Checklist #3 fallback to `openai-completions` |
