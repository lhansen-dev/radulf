import fs from "node:fs";
import path from "node:path";

import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  VERSION,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { ProviderId } from "../providers";
import type { RunSandboxContext } from "../sandbox/context";
import { createSandboxedBashOperations } from "../sandbox/srt";
import { getSettings, type Settings } from "../settings";
import { createGuardedFsTools } from "./guardedTools";
import { agentEnv, type TranscriptEvent } from "./types";
import { createWebSearchTool } from "./webSearch";

/**
 * The pi SDK runner (spec 13). One in-process harness serves every provider —
 * no `RunnerAdapter` seam, no CLI subprocess. Providers differ only in how
 * their `Model` is resolved and authenticated; everything downstream (session
 * construction, normalization, tool set) is identical.
 */

/**
 * Minimal system prompt for the loop agent. Behavior lives in
 * .ralph/PROMPT.md, unchanged. Replaces pi's default prompt via the resource
 * loader's systemPromptOverride (the SDK analog of the CLI --system-prompt).
 */
const RALPH_SYSTEM_PROMPT =
  "You are executing one iteration of an autonomous coding loop. Follow the instructions in the user message exactly.";

/** thinking level derived from the SDK so it can't drift from the package. */
type ThinkingLevel = NonNullable<
  Parameters<typeof createAgentSession>[0]
>["thinkingLevel"];
const THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
function toThinkingLevel(level: string): ThinkingLevel {
  return (THINKING_LEVELS.includes(level) ? level : "medium") as ThinkingLevel;
}

/**
 * Radulf provider id → pi provider id. pi calls the ChatGPT subscription
 * `openai-codex` and the Copilot subscription `github-copilot`; oMLX is a custom
 * provider we register at runtime; the rest match by name.
 */
const PI_PROVIDER: Record<ProviderId, string> = {
  anthropic: "anthropic",
  chatgpt: "openai-codex",
  copilot: "github-copilot",
  omlx: "omlx",
  openrouter: "openrouter",
};

// ---------------------------------------------------------------------------
// Persistent, Radulf-owned pi agent dir (spec 13)
// ---------------------------------------------------------------------------

function radulfDataDir(): string {
  return process.env.RADULF_DATA_DIR ?? path.join(process.cwd(), "data");
}

/**
 * One Radulf-owned pi agent dir, shared by every run. Holds `auth.json` (the
 * subscription logins established once via `make login` → `/login`, which points
 * pi's PI_CODING_AGENT_DIR here rather than at the user's `~/.pi/agent`) and lets
 * `models.json` persist — this is the deliberate narrowing of spec 12's
 * per-run isolation: isolate from the user's personal `~/.pi`, but persist the
 * app's own auth. Context reproducibility (no user extensions/skills/…) is
 * enforced by the session options, not by an empty dir.
 */
export function piAgentDir(): string {
  return path.join(radulfDataDir(), "pi-agent");
}

/**
 * The shared, long-lived ModelRuntime. Constructed once so subscription OAuth
 * in `auth.json` persists across runs and `getAvailable()` sees every logged-in
 * provider. Auth and the oMLX/OpenRouter runtime overrides all flow through it.
 */
let runtimePromise: Promise<ModelRuntime> | undefined;
export function getModelRuntime(): Promise<ModelRuntime> {
  if (!runtimePromise) {
    const dir = piAgentDir();
    fs.mkdirSync(dir, { recursive: true });
    runtimePromise = ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: path.join(dir, "models.json"),
    });
  }
  return runtimePromise;
}

/** Reset the runtime singleton — test seam only. */
export function resetModelRuntime(): void {
  runtimePromise = undefined;
}

/**
 * The oMLX custom-provider block. Shape from spec 12 (`anthropic-messages`
 * matches spec 09's @ai-sdk/anthropic choice; `openai-completions` is the
 * documented fallback if /v1/messages doesn't slot cleanly). Registered on the
 * runtime per run rather than written to disk, so a per-card model id resolves
 * without rewriting models.json.
 */
export function omlxProviderConfig(model: string, s: Settings) {
  return {
    name: "oMLX",
    baseUrl: s.omlxBaseUrl,
    apiKey: s.omlxApiKey || "omlx",
    api: "anthropic-messages" as const,
    models: [
      {
        id: model,
        name: model,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    ],
  };
}

/**
 * Resolve a concrete pi `Model` for a run, applying the blank-model rules and
 * the per-provider auth setup:
 *
 * - `openrouter`/`omlx` throw on a blank model (a blank would resolve pi's own
 *   default, wrong for both).
 * - `anthropic`/`chatgpt`/`copilot` treat a blank model as "the subscription
 *   default" — the same latitude `claude -p` / `codex exec` had.
 */
async function resolveModel(
  runtime: ModelRuntime,
  provider: ProviderId,
  model: string,
  s: Settings,
) {
  const pid = PI_PROVIDER[provider];

  if (provider === "openrouter") {
    if (!model) {
      throw new Error(
        "no model selected for the OpenRouter provider — pick one in Settings before running (a blank model would fall back to an expensive default)",
      );
    }
    await runtime.setRuntimeApiKey("openrouter", s.openrouterApiKey);
    const m = runtime.getModel(pid, model);
    if (!m) throw new Error(`OpenRouter does not serve model "${model}"`);
    return m;
  }

  if (provider === "omlx") {
    if (!model) {
      throw new Error(
        "no model selected for the oMLX provider — the pi harness needs an explicit model id; pick one in Settings before running",
      );
    }
    runtime.registerProvider("omlx", omlxProviderConfig(model, s));
    const m = runtime.getModel(pid, model);
    if (!m) throw new Error(`oMLX does not serve model "${model}"`);
    return m;
  }

  // anthropic / chatgpt / copilot: subscription auth lives in the Radulf agent dir.
  if (model) {
    const m = runtime.getModel(pid, model);
    if (!m) throw new Error(`${provider} does not serve model "${model}"`);
    return m;
  }
  // Blank model → the subscription's default. getAvailable() returns the
  // authenticated models for the provider; the first is pi's default.
  const available = await runtime.getAvailable(pid);
  if (available.length === 0) {
    throw new Error(
      `no ${provider} models available — run \`make login\` and type /login in pi to establish the subscription (agent dir: ${piAgentDir()})`,
    );
  }
  return available[0];
}

// ---------------------------------------------------------------------------
// Normalization — SDK event OBJECTS, not JSONL strings
// ---------------------------------------------------------------------------

/**
 * Normalize one pi SDK event object into transcript events.
 *
 * Field mapping is pinned against the SDK's emitted types (packages/ai):
 * `message_end` carries `message: AssistantMessage` (content parts, usage,
 * stopReason); `auto_retry_end` carries `success`/`finalError`. Streaming
 * deltas and lifecycle framing are dropped deliberately — their content is
 * fully duplicated by `message_end`. Everything unrecognized is preserved as
 * `t:"raw"` with a stringified event so nothing is lost.
 */
export function piNormalize(evt: AgentSessionEvent): TranscriptEvent[] {
  const raw = (): TranscriptEvent[] => [{ t: "raw", line: JSON.stringify(evt) }];

  if (evt.type === "message_end") {
    const message = evt.message as unknown as Record<string, unknown> | undefined;
    if (message?.role !== "assistant") return raw();

    const events: TranscriptEvent[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      const p = part as Record<string, unknown>;
      if (p.type === "text") {
        const text = String(p.text ?? "");
        if (text) events.push({ t: "text", role: "assistant", content: text });
      } else if (p.type === "toolCall") {
        events.push({ t: "tool", name: String(p.name ?? ""), input: p.arguments });
      }
    }

    // Pi's Usage: `input` excludes cache reads/writes; `reasoning` is a subset
    // of `output`, reported only by providers that expose it; `cost.total` is
    // USD. One assistant message_end per model turn.
    const usage = message.usage as
      | {
          input?: unknown;
          output?: unknown;
          cacheRead?: unknown;
          cacheWrite?: unknown;
          reasoning?: unknown;
          cost?: { total?: unknown };
        }
      | undefined;
    if (usage && typeof usage === "object") {
      const timestampMs = Number(message.timestamp);
      const costUsd = Number(usage.cost?.total);
      events.push({
        t: "usage",
        inputTokens: Number(usage.input ?? 0),
        outputTokens: Number(usage.output ?? 0),
        ...(usage.cacheRead !== undefined
          ? { cachedInputTokens: Number(usage.cacheRead) }
          : {}),
        ...(usage.cacheWrite !== undefined
          ? { cacheWriteTokens: Number(usage.cacheWrite) }
          : {}),
        ...(usage.reasoning !== undefined
          ? { reasoningTokens: Number(usage.reasoning) }
          : {}),
        ...(Number.isFinite(costUsd) ? { costUsd } : {}),
        ...(Number.isFinite(timestampMs) ? { timestampMs } : {}),
      });
    }

    const stopReason = message.stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      events.push({
        t: "result",
        exit: "failed",
        detail: String(message.errorMessage ?? `stopReason: ${stopReason}`),
      });
    }
    return events;
  }

  if (evt.type === "auto_retry_end" && evt.success === false) {
    return [
      {
        t: "result",
        exit: "failed",
        detail: String(evt.finalError ?? "model request failed after retries"),
      },
    ];
  }

  // Lifecycle framing that message_end fully duplicates — drop it.
  if (
    evt.type === "agent_start" ||
    evt.type === "agent_end" ||
    evt.type === "turn_start" ||
    evt.type === "turn_end" ||
    evt.type === "message_start" ||
    evt.type === "message_update" ||
    evt.type === "tool_execution_start" ||
    evt.type === "tool_execution_update"
  ) {
    return [];
  }

  // tool_execution_end (tool outputs), retry-start, queue/compaction/session
  // events, and anything unknown are preserved as raw.
  return raw();
}

// ---------------------------------------------------------------------------
// Session construction
// ---------------------------------------------------------------------------

/**
 * Pipeline role (spec 14): containment is per-role as well as per-run, so the
 * two dangerous primitives — arbitrary command execution and network egress —
 * never sit in the same role. The planner can reach the web but cannot spawn
 * a process; the loop and evaluator can spawn processes but hold no network
 * primitive outside L1's proxy.
 */
export type AgentRole = "planner" | "loop" | "evaluator";

/**
 * The built-in tool list for a session (spec 14 role capability split).
 *
 * | Role      | bash | web_search | fs tools                       |
 * |-----------|------|------------|--------------------------------|
 * | planner   | ✗    | ✓ (only)   | read/grep/find/ls + write/edit |
 * | loop      | ✓    | ✗          | full set                       |
 * | evaluator | ✓    | ✗          | full set                       |
 *
 * `readOnly` (planner chat, improvement proposer — human-interactive, outside the pipeline
 * roles) keeps the read-only browse set plus web_search. With no role and not
 * readOnly the loop set applies — never web_search by default.
 */
export function toolsForRole(role: AgentRole | undefined, readOnly: boolean): string[] {
  if (readOnly) return ["read", "grep", "find", "ls", "web_search"];
  if (role === "planner") {
    // write/edit are bound but L2-guarded to the run's plan dir (Phase 3);
    // no bash — a planner needing command execution is being manipulated.
    return ["read", "grep", "find", "ls", "write", "edit", "web_search"];
  }
  return ["read", "bash", "edit", "write", "grep", "find", "ls"];
}

/**
 * The Layer 2 path roots for a role (spec 14 Phase 3). The in-process file
 * tools are guarded against these before delegating to pi's built-ins.
 *
 * | Role      | Read roots      | Write roots        |
 * |-----------|-----------------|--------------------|
 * | planner   | repo checkout   | `<worktree>/.ralph`|
 * | loop      | worktree        | worktree           |
 * | evaluator | worktree        | worktree           |
 *
 * `cwd` is the worktree (the repo checkout, for the planner). The planner may
 * read the whole checkout but write only its `.ralph/` artifacts — it cannot
 * touch source. (Spec 14's table named a separate `plans/<run-id>/` dir, but
 * the planner's artifacts must live in the worktree's `.ralph/` where
 * planningService and the loop consume them; the write root is that subtree.)
 * The net doc/`.ralph`-only constraint on the evaluator is enforced by the
 * post-run integrity check (Phase 2a), not L2.
 */
export function pathRootsForRole(
  role: AgentRole,
  cwd: string,
): { readRoots: string[]; writeRoots: string[] } {
  if (role === "planner") {
    return { readRoots: [cwd], writeRoots: [path.join(cwd, ".ralph")] };
  }
  return { readRoots: [cwd], writeRoots: [cwd] };
}

/**
 * Layer 1 (spec 14 Phase 6): only the two bash-holding pipeline roles are
 * ever srt-wrapped — the planner has no bash tool, and non-pipeline
 * sessions (chat, improvement proposer) are out of scope for L1 by design. A missing
 * `srtConfig` for one of these roles means `sandboxEnabled` is off (an
 * explicit, stamped operator choice, enforced by the caller's preflight —
 * see orchestrator.ts/evaluationService.ts) — this function only decides
 * routing, never whether sandboxing was supposed to happen.
 */
export function shouldSandboxBash(
  role: AgentRole | undefined,
  srtConfig: unknown,
): boolean {
  return (role === "loop" || role === "evaluator") && srtConfig !== undefined;
}

export type CreateRalphSessionOpts = {
  provider: ProviderId;
  model: string;
  reasoningLevel: string;
  cwd: string;
  /** Pipeline role — decides the tool set (and, in L2, the path roots). */
  role?: AgentRole;
  readOnly?: boolean;
  /** Per-run sandbox context (spec 14): allowlist env, run-private TMPDIR and
   * caches, and the resource-limit/pgid command preamble. Absent for
   * contextless sessions (chat, improvement proposer), which fall back to the plain
   * allowlist env. */
  runContext?: RunSandboxContext;
  s?: Settings;
};

/**
 * Build a configured, ready-to-prompt pi session for one run.
 *
 * - **Built-in tool set = the Ralph set** (read, bash, edit, write, grep, find,
 *   ls) on a work run; read-only (chat) runs get the restricted list.
 * - **Env isolation (Security option 1):** the built-in bash is replaced by a
 *   custom bash whose spawn env is `agentEnv()`, so the agent structurally
 *   cannot read Radulf's own secrets. A custom tool named "bash" overrides the
 *   built-in of the same name in the SDK's tool registry.
 * - **Reproducible context:** SettingsManager.inMemory() + systemPromptOverride
 *   + disabled extensions/skills/prompt-templates/themes/context-files — the
 *   SDK analog of the CLI's --no-* flags, so nothing user- or repo-injected
 *   reaches the run.
 */
export async function createRalphSession(
  opts: CreateRalphSessionOpts,
): Promise<AgentSession> {
  const s = opts.s ?? getSettings();
  if (!opts.reasoningLevel) {
    throw new Error(
      "the pi harness requires a reasoning level — pass reasoningLevel to runHarness (per-agent setting)",
    );
  }

  const runtime = await getModelRuntime();
  const model = await resolveModel(runtime, opts.provider, opts.model, s);
  const dir = piAgentDir();

  // Custom bash whose subprocess env is the spec-14 allowlist env. Overrides
  // the built-in "bash" by name in the tool registry. The commandPrefix
  // carries the L3 resource-limit + pgid-recording preamble; the spawnHook
  // swaps in the run's env. Cast through unknown: the concrete definition's
  // schema is narrower than the ToolDefinition[] element type (renderCall
  // variance), which is safe here.
  //
  // Layer 1 (spec 14 Phase 6): srt-wraps the command via a custom
  // `operations.exec`, not `spawnHook` — `BashSpawnHook` is synchronous
  // (`(ctx) => ctx`) and `SandboxManager.wrapWithSandbox` is async, so the
  // rewrite can't happen there (amends the plan's original "extend
  // spawnHook" note). Only for bash-holding pipeline roles (loop,
  // evaluator) with a resolved `srtConfig` — its absence means either
  // `sandboxEnabled` is off (an explicit operator choice, stamped on the
  // run row) or this is a non-pipeline session (chat, improvement proposer), never a
  // silent skip of an intended sandbox.
  const runContext = opts.runContext;
  const scrubbedBash = createBashToolDefinition(opts.cwd, {
    commandPrefix: runContext?.commandPrefix,
    spawnHook: (ctx) => ({ ...ctx, env: runContext?.env ?? agentEnv() }),
    operations:
      shouldSandboxBash(opts.role, runContext?.srtConfig) && runContext?.srtConfig
        ? createSandboxedBashOperations(runContext.srtConfig)
        : undefined,
  }) as unknown as ToolDefinition;

  // Web search (Brave) — pi has no web tool and extensions are disabled, so
  // the tool is injected as a custom tool. Spec 14: planner (and read-only
  // chat) ONLY — the roles that hold bash never hold a network primitive. A
  // blank key makes it throw at call time rather than vanish.
  const webSearch = createWebSearchTool(s.braveApiKey);

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => RALPH_SYSTEM_PROMPT,
  });
  await resourceLoader.reload();

  const tools = toolsForRole(opts.role, Boolean(opts.readOnly));
  // Only inject the custom tools the role's tool set actually names — a
  // custom tool would otherwise be bound regardless of the `tools` list.
  const customTools: ToolDefinition[] = [];
  if (tools.includes("bash")) customTools.push(scrubbedBash);
  if (tools.includes("web_search")) customTools.push(webSearch);
  // Layer 2 path containment (spec 14 Phase 3): for the pipeline roles, the
  // in-process file tools are replaced by guard-then-delegate wrappers bound
  // to the role's roots. Human-interactive sessions (chat, improvement proposer — no role)
  // keep pi's unguarded built-ins. Guarded tools override the built-ins by
  // name, so only the ones the role's tool set names take effect.
  if (opts.role) {
    const { readRoots, writeRoots } = pathRootsForRole(opts.role, opts.cwd);
    for (const guarded of createGuardedFsTools(opts.cwd, readRoots, writeRoots)) {
      if (tools.includes(guarded.name)) customTools.push(guarded);
    }
  }

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: dir,
    modelRuntime: runtime,
    model,
    thinkingLevel: toThinkingLevel(opts.reasoningLevel),
    tools,
    customTools,
    resourceLoader,
    settingsManager,
  });
  return session;
}

/** The installed pi SDK version — the harness version, no subprocess needed. */
export function harnessPackageVersion(): string {
  return VERSION;
}

/**
 * List the models a pi-authenticated provider serves, for the pickers. Replaces
 * the deleted claude/codex CLI-cache helpers: `getAvailable()` returns the
 * authenticated models across every logged-in provider from one source.
 */
export async function listAuthedModels(
  provider: ProviderId,
): Promise<
  {
    value: string;
    displayName: string;
    description: string;
    costPerMillionInput?: number;
    costPerMillionOutput?: number;
  }[]
> {
  const runtime = await getModelRuntime();
  const models = await runtime.getAvailable(PI_PROVIDER[provider]);
  // pi's model catalog already prices in USD per 1M tokens (its cost rates
  // are applied directly against raw token counts elsewhere), so these pass
  // straight through with no unit conversion.
  return models.map((m) => ({
    value: m.id,
    displayName: m.name || m.id,
    description: "",
    ...(Number.isFinite(m.cost?.input) ? { costPerMillionInput: m.cost.input } : {}),
    ...(Number.isFinite(m.cost?.output) ? { costPerMillionOutput: m.cost.output } : {}),
  }));
}
