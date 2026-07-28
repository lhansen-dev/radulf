# Spec 13 implementation checklist

Working branch: `feat/spec-13-pi-sdk-harness`. Tracks the work to land
[13-single-pi-sdk-harness.md](13-single-pi-sdk-harness.md). Check items off as
they land so another model can resume mid-flight.

## Settled decisions (this session)

- **Full switch + delete now.** All four providers route through the SDK runner;
  the claude-code/codex CLI adapters, the `RunnerAdapter` seam, the subprocess
  machinery, and the CLI model-cache helpers are deleted in this branch (no
  temporary bridge, no toggle). Matches the memory posture: one code path.
- **Security = spec option 1.** The built-in `bash` tool gets a `spawnHook`
  returning `agentEnv()` (process.env minus `RADULF_AUTH_SECRET`,
  `RADULF_AUTH_PASSWORD_HASH`, `OPENROUTER_API_KEY`). No worker thread, no
  auth/session refactor.

## SDK facts pinned against `@earendil-works/pi-coding-agent@0.80.10`

(installed into `dependencies`; the `pi` CLI on this machine is 0.80.7)

- `createAgentSession(opts)` → `{ session, extensionsResult, modelFallbackMessage }`.
  Options that matter: `cwd`, `agentDir`, `modelRuntime`, `model: Model<any>`
  (an object, **not** a string), `thinkingLevel: ThinkingLevel`, `tools`,
  `noTools`, `excludeTools`, `customTools`, `resourceLoader`, `settingsManager`.
  There is **no** `provider` option and **no** `systemPromptOverride` option.
- `AgentSession`: `subscribe(listener) => unsubscribe`, `prompt(text, opts) => Promise<void>`,
  `abort() => Promise<void>` (**the interrupt entry point** — checklist #4),
  `dispose()`.
- `AgentSessionEvent` = base `AgentEvent` (`message_end` carries
  `message: AssistantMessage` with `content[]`, `usage`, `stopReason`,
  `errorMessage`, `timestamp`) plus session events including `auto_retry_end`
  (`success`, `finalError`). Field mapping matches the old CLI `piNormalize`;
  only the input type changes (object, not JSONL string).
- `AssistantMessage.usage`: `input`, `output`, `cacheRead`, `cacheWrite`,
  `reasoning?`, `cost.total`. `content[]` parts are `{type:"text",text}` /
  `{type:"toolCall",id,name,arguments}` / thinking.
- `ThinkingLevel = "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"`.
- `ModelRuntime.create({ authPath?, modelsPath?, ... })` — note: options are
  `authPath`/`modelsPath`, **not** `agentDir`. Methods: `getModel(provider,id)`,
  `getAvailable(provider?)`, `setRuntimeApiKey(provider,key)`,
  `registerProvider(id,config)`, `login(...)`.
- `SettingsManager.inMemory(partial?, opts?)`, `DefaultResourceLoader({ cwd,
  agentDir, noExtensions, noSkills, noPromptTemplates, noThemes, noContextFiles,
  systemPromptOverride })`.
- Bash env lever: `createBashToolDefinition(cwd, { spawnHook })`; `spawnHook`
  receives `{command,cwd,env}` and can rewrite `env`.
- **Radulf provider → pi provider id:** `anthropic`→`anthropic` (OAuth Claude
  Pro/Max), `chatgpt`→**`openai-codex`** (OAuth ChatGPT Plus/Pro), `omlx`→custom
  registered `omlx`, `openrouter`→`openrouter`. pi's `providers.md` confirms
  spec input #2: Anthropic subscription auth is live for third-party harnesses,
  billed per token.

## Implementation tasks — DONE on `feat/spec-13-pi-sdk-harness`

- [x] `harness/types.ts`: `HarnessId = "pi"`; deleted `RunnerAdapter`/`RunnerSpawn`;
      kept `TranscriptEvent` + `agentEnv()`.
- [x] `harness/pi.ts`: rewritten as the SDK session module — shared `ModelRuntime`
      over the persistent Radulf agent dir (`getModelRuntime()`), per-provider
      model resolution (`resolveModel`, blank-model rules, `openai-codex`
      mapping, oMLX `registerProvider`), object-input `piNormalize`, env-scrub
      bash tool (`createBashToolDefinition` + `spawnHook`), `createRalphSession`,
      `harnessPackageVersion()` (reads the SDK `VERSION`), `listAuthedModels`.
- [x] `harness/index.ts`: `runHarness` drives one in-process session
      (subscribe → normalize → fold; races `prompt()` against a watchdog that
      fires `session.abort()` on timeout/stall/AbortSignal; `dispose()` in
      finally). Kept `RunnerResult`/`TranscriptTotals`/`foldTranscriptEvent`/
      `createTranscriptTotals`. Dropped `adapterFor`, the spawn machinery,
      `isUnavailableCodexModelError`, the chatgpt blank-model retry. Added a
      `createSession` test seam + `HarnessSession` type.
- [x] Deleted `harness/claudeCode.ts` (+test), `harness/codex.ts` (+test),
      `server/models.ts`, `server/codexModels.ts` (+test), and the stale CLI
      transcript fixtures.
- [x] `server/providers.ts`: `listProviderModels`/`preflightProvider` uniform;
      anthropic/chatgpt via `listAuthedModels` (getAvailable); oMLX/OpenRouter
      keep their live HTTP lists; CLI-cache imports dropped.
- [x] `server/transcript.ts`: dropped the `claudeCodeNormalize` fallback →
      untagged line becomes `{t:"raw"}`.
- [x] `server/settings.ts`: reasoning-level comment fixed (applies to every
      provider now).
- [x] `next.config.ts`: added `serverExternalPackages:
      ["@earendil-works/pi-coding-agent"]` so the SDK is required at runtime, not
      bundled (silences the "too dynamic" MODULE_NOT_FOUND probes).
- [x] Tests: rewrote `harness/pi.test.ts` (object-input normalize +
      `omlxProviderConfig`); rewrote `harness/index.test.ts` watchdog suite on
      the new session seam. `orchestrator.lifecycle.test.ts` unchanged (result
      shape kept).
- [x] Docs: spec 00 (index row already present; decisions 3/4/7 + glossary
      re-amended), spec 02 (shape, responsibilities, runner contracts, diagram),
      spec 04 (intro + planning + loop pseudocode), README (stack +
      requirements + settings section), settings & info UI copy.
- [x] `npm run lint`, `npm run typecheck`, `npm test` (395), `npm run build` all
      green.

## Still to do (needs the user)

- [ ] Commit the branch / open a PR (not done — awaiting your go-ahead).
- [ ] The live-SDK verification items below, which need a real `pi login`.

## Must-verify against the LIVE SDK before trusting subscription runs

These need a real `pi login` (interactive OAuth) that could not be run in this
session — they are the spec's verification checklist, still open:

- [ ] **#2 subscription blank-model** — `getModel("anthropic"/"openai-codex")`
      with a blank id resolves the subscription default and completes a run.
      (Current code's blank-model fallback for these is a best-effort
      "first available"; confirm/replace.)
- [ ] **#3 `getAvailable()`** — returns authenticated models for all four
      providers; shape suits the pickers; confirm oMLX handling (custom-provider
      vs the live HTTP list kept in providers.ts).
- [ ] **#6 env isolation (ship gate)** — an agent told to `echo
      $RADULF_AUTH_SECRET` / read the password hash sees nothing. Gates
      self-improvement cards.
- [ ] **#7 persistent auth dir** — the Radulf agent dir keeps both subscription
      logins across restarts; a populated user `~/.pi/agent` has zero effect.
- [ ] oMLX custom-provider model definition — confirm `registerProvider`/
      models.json accepts the minimal `{id}` block or fill required fields
      (cost/contextWindow/api).

## Manual step the user owns

Run once, pointed at the Radulf agent dir (path chosen in code: `data/pi-agent/`):
`pi login` → Claude Pro/Max, and `pi login` → ChatGPT (Codex). The claude/codex
CLIs are no longer invoked and need not be installed.
