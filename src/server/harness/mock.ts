import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * The mock provider: a deterministic, scripted stand-in for the model, so the
 * whole pipeline (planner → loop → evaluator) can be exercised end to end for
 * free. Only the model's *decisions* are canned — pi still executes every tool
 * call for real, so worktrees, guarded file tools, sandboxed bash, signal
 * files, git commits, transcripts, telemetry, the DB, and SSE all run as they
 * would against a real provider.
 *
 * Opt-in: disabled unless the server runs with RADULF_MOCK_LLM=1. A stored
 * `mock` provider on a server without the flag fails loudly — it never falls
 * back to a paid provider. The model id picks the scenario.
 *
 * Each reply is chosen from the request alone (role, prompt, and how many
 * turns the session has taken), so the provider holds no state and concurrent
 * sessions can't interfere.
 */

export function mockProviderEnabled(): boolean {
  return process.env.RADULF_MOCK_LLM === "1";
}

function assertMockProviderEnabled(): void {
  if (!mockProviderEnabled()) {
    throw new Error(
      "the mock provider is disabled — start the server with RADULF_MOCK_LLM=1 to use it",
    );
  }
}

// pi-ai is only a transitive dependency, so its types are reached through the
// one pi-coding-agent API the mock plugs into.
type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
type StreamSimple = NonNullable<ProviderConfig["streamSimple"]>;
type Model = Parameters<StreamSimple>[0];
type Context = Parameters<StreamSimple>[1];
type EventStream = ReturnType<StreamSimple>;
type AssistantMessage = Awaited<ReturnType<EventStream["result"]>>;
type AssistantEvent = EventStream extends AsyncIterable<infer E> ? E : never;
type Block = AssistantMessage["content"][number];
type ToolArgs = Extract<Block, { type: "toolCall" }>["arguments"];

type MockRole = "planner" | "loop" | "evaluator" | "readOnly";

/** What a script sees of the request. */
type Turn = {
  /** The session's first user message — the rendered stage prompt. */
  prompt: string;
  /** Assistant turns already taken this session (0 on the first call). */
  step: number;
  /** Text of the most recent tool result, "" when there is none. */
  lastToolOutput: string;
};

/** A scripted reply: content blocks, a provider error, or a stream that never
 * produces anything until the session aborts it. */
type Reply = Block[] | { error: string } | "hang";
type Script = (turn: Turn) => Reply;

let toolCallSeq = 0;
const say = (text: string): Block => ({ type: "text", text });
const think = (thinking: string): Block => ({ type: "thinking", thinking });
const call = (name: string, args: ToolArgs): Block => ({
  type: "toolCall",
  id: `mock-call-${++toolCallSeq}`,
  name,
  arguments: args,
});
const write = (path: string, content: string) => call("write", { path, content });
const bash = (command: string) => call("bash", { command });

// ---------------------------------------------------------------------------
// The happy path, per role
// ---------------------------------------------------------------------------

const PLAN_PROMPT_MD =
  "Do exactly the assigned task: write the file it names with the task text as its content, then write the signal file.\n";

const planner: Script = ({ prompt, step }) => {
  if (step > 0) return [say("Plan written to .ralph/.")];
  // A re-plan (evaluator revise or human reject) carries the feedback section.
  const tasks = prompt.includes("PREVIOUS ATTEMPT")
    ? ["Address the reviewer feedback in mock-output/feedback.md"]
    : ["Create mock-output/task-1.md", "Create mock-output/task-2.md"];
  return [
    think("Scripted plan: one file per task, no real analysis."),
    write(".ralph/PLAN.md", `# Plan\n\n## Tasks\n${tasks.map((t) => `- [ ] ${t}`).join("\n")}\n`),
    write(".ralph/CRITERIA.md", "- Every task's file exists under mock-output/.\n"),
    write(".ralph/PROMPT.md", PLAN_PROMPT_MD),
  ];
};

/** The task the orchestrator injected (bookkeeping.ts taskInjectionBlock). */
function assignedTask(prompt: string) {
  return {
    n: Number(/^Task #(\d+):/m.exec(prompt)?.[1] ?? 0),
    text: /^Task #\d+:\n(.*)$/m.exec(prompt)?.[1] ?? "",
    last: /^LAST_TASK=true$/m.test(prompt),
  };
}

const loop: Script = ({ prompt, step }) => {
  const task = assignedTask(prompt);
  const signal = task.last ? ".ralph/DONE" : ".ralph/ITERATION_DONE";
  switch (step) {
    case 0:
      // Stamped per write: another card may already have merged this same
      // path and text into the base branch, and identical bytes would be no
      // work product at all — a phantom completion, then a stall.
      return [write(`mock-output/task-${task.n}.md`, `${task.text}\n\nmock write ${Date.now()}-${++toolCallSeq}\n`)];
    case 1:
      return [bash("git status --short")];
    case 2:
      return [write(signal, `Completed task ${task.n}: ${task.text}\n`)];
    default:
      return [say(`Task ${task.n} done.`)];
  }
};

const approve = (): Block[] => [
  write(".ralph/EVALUATION.md", "VERDICT: approve\n\nMock evaluation: every task left its file.\n"),
  write(".ralph/SUMMARY.md", "Mock run: created one file per planned task under mock-output/.\n"),
];

const evaluator: Script = ({ step }) => {
  // --first-parent: this branch's own commits, not ones other cards merged
  // into the base branch.
  if (step === 0) return [bash("git log --first-parent --format=%s")];
  if (step === 1) return approve();
  return [say("Evaluation written.")];
};

/** Scoping and the improvement proposer (read-only, no pipeline role).
 * One reply serves both: prose for scoping, a JSON proposal for the
 * proposer (pm.ts parseProposals). */
const readOnly: Script = () => [
  say(
    "Mock reply — no model was called.\n\n```json\n" +
      JSON.stringify([
        {
          title: "Mock improvement",
          description: "Create mock-output/improvement.md.",
          rationale: "Scripted by the mock provider.",
        },
      ]) +
      "\n```",
  ),
];

const HAPPY: Record<MockRole, Script> = { planner, loop, evaluator, readOnly };

// ---------------------------------------------------------------------------
// Scenarios — the model id. Each overrides the happy path for some roles.
// ---------------------------------------------------------------------------

const everyRole = (script: Script): Record<MockRole, Script> => ({
  planner: script,
  loop: script,
  evaluator: script,
  readOnly: script,
});

const MOCK_SCENARIOS: Record<string, { description: string; scripts: Partial<Record<MockRole, Script>> }> = {
  "happy-path": {
    description: "Two-task plan, both tasks done, evaluator approves.",
    scripts: {},
  },
  "revise-once": {
    description: "Evaluator asks for a revision once, then approves the re-planned work.",
    scripts: {
      evaluator: (turn) => {
        if (turn.step !== 1) return evaluator(turn);
        // Step 0 ran `git log`; an earlier revise leaves its commit behind.
        if (turn.lastToolOutput.includes("ralph: evaluation — revise")) return approve();
        return [
          write(".ralph/EVALUATION.md", "VERDICT: revise\n\nMock revision: add mock-output/feedback.md.\n"),
        ];
      },
    },
  },
  "planner-questions": {
    description: "Planner raises follow-up questions instead of a plan.",
    scripts: {
      planner: ({ step }) =>
        step === 0
          ? [write(".ralph/QUESTIONS.md", "Mock question: which file should the change go in?\n")]
          : [say("Questions written.")],
    },
  },
  "provider-error": {
    description: "Every request fails with a provider error.",
    scripts: everyRole(() => ({ error: "mock provider-error scenario: 400 invalid request" })),
  },
  stuck: {
    description: "Loop repeats the same tool call until the stuck detector kills it.",
    scripts: { loop: () => [bash("ls")] },
  },
  phantom: {
    description: "Loop signals ITERATION_DONE without changing anything, until the stall limit.",
    scripts: {
      loop: ({ step }) =>
        step === 0 ? [write(".ralph/ITERATION_DONE", "Claimed done.\n")] : [say("Done (not really).")],
    },
  },
  stall: {
    description: "The stream never produces output, until the stall watchdog aborts it.",
    scripts: everyRole(() => "hang"),
  },
  "loop-blocked": {
    description: "Loop reports a blocker outside its control instead of completing its task.",
    scripts: {
      loop: ({ step }) =>
        step === 0
          ? [write(".ralph/BLOCKED", "Mock blocker: the sandbox has no credentials for the live service.\n")]
          : [say("Blocked; reported, not faked.")],
    },
  },
  "off-branch": {
    description: "Loop checks the worktree out onto another branch before signalling; the orchestrator refuses to commit.",
    scripts: {
      loop: ({ step }) => {
        switch (step) {
          case 0:
            return [bash("git checkout -q -b escaped")];
          case 1:
            return [write("mock-output/escaped.md", `written off the run branch ${Date.now()}\n`)];
          case 2:
            return [write(".ralph/ITERATION_DONE", "Done, on the wrong branch.\n")];
          default:
            return [say("Done.")];
        }
      },
    },
  },
};

export const DEFAULT_MOCK_SCENARIO = "happy-path";

/** The scenarios, shaped for the provider model pickers. */
export function mockProviderModels(): { value: string; displayName: string; description: string }[] {
  assertMockProviderEnabled();
  return Object.entries(MOCK_SCENARIOS).map(([id, s]) => ({
    value: id,
    displayName: id,
    description: s.description,
  }));
}

// ---------------------------------------------------------------------------
// Request → scripted reply
// ---------------------------------------------------------------------------

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("\n");
}

/** The tool set the transcript declares. pi folds `Context.tools` into the
 * leading system message before a provider sees it, so the names arrive as
 * `toolsAdded`/`toolsRemoved` deltas rather than a field on the context. */
function declaredTools(ctx: Context): Set<string> {
  const names = new Set<string>();
  for (const message of ctx.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
  }
  return names;
}

/** Role from the tool set toolsForRole() bound (pi.ts): only loop and
 * evaluator hold bash, only the planner writes without it. */
function roleOf(ctx: Context, prompt: string): MockRole {
  const tools = declaredTools(ctx);
  if (tools.has("bash")) return /^LAST_TASK=/m.test(prompt) ? "loop" : "evaluator";
  if (tools.has("write")) return "planner";
  return "readOnly";
}

function reply(model: Model, ctx: Context): Reply {
  const prompt = messageText(ctx.messages.find((m) => m.role === "user")?.content);
  const lastTool = ctx.messages.findLast((m) => m.role === "toolResult");
  const turn: Turn = {
    prompt,
    step: ctx.messages.filter((m) => m.role === "assistant").length,
    lastToolOutput: lastTool ? messageText(lastTool.content) : "",
  };
  const role = roleOf(ctx, prompt);
  const scenario = MOCK_SCENARIOS[model.id] ?? MOCK_SCENARIOS[DEFAULT_MOCK_SCENARIO];
  return (scenario.scripts[role] ?? HAPPY[role])(turn);
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

function assistantMessage(
  model: Model,
  ctx: Context,
  content: Block[],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  const input = estimateTokens(JSON.stringify(ctx.messages));
  const output = estimateTokens(JSON.stringify(content));
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    // Rough, non-zero token counts so analytics have something to show; a
    // mock costs nothing.
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

/** Events for one finished message, in the order a streaming provider emits
 * them — one delta per block, so the reply-size guard still counts them. */
function* messageEvents(message: AssistantMessage): Generator<AssistantEvent> {
  yield { type: "start", partial: { ...message, content: [] } };
  for (const [contentIndex, block] of message.content.entries()) {
    const snapshot = { ...message, content: message.content.slice(0, contentIndex + 1) };
    if (block.type === "text") {
      yield { type: "text_start", contentIndex, partial: snapshot };
      yield { type: "text_delta", contentIndex, delta: block.text, partial: snapshot };
      yield { type: "text_end", contentIndex, content: block.text, partial: snapshot };
    } else if (block.type === "thinking") {
      yield { type: "thinking_start", contentIndex, partial: snapshot };
      yield { type: "thinking_delta", contentIndex, delta: block.thinking, partial: snapshot };
      yield { type: "thinking_end", contentIndex, content: block.thinking, partial: snapshot };
    } else {
      const args = JSON.stringify(block.arguments);
      yield { type: "toolcall_start", contentIndex, partial: snapshot };
      yield { type: "toolcall_delta", contentIndex, delta: args, partial: snapshot };
      yield { type: "toolcall_end", contentIndex, toolCall: block, partial: snapshot };
    }
  }
}

/** Resolves once `signal` aborts — never, without one. */
function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

const streamSimple: StreamSimple = (model, ctx, options) => {
  let resolveResult!: (message: AssistantMessage) => void;
  const result = new Promise<AssistantMessage>((resolve) => (resolveResult = resolve));

  async function* events(): AsyncGenerator<AssistantEvent> {
    const scripted = reply(model, ctx);
    if (scripted === "hang") await untilAborted(options?.signal);
    // result() is settled before each terminal event: the agent loop awaits
    // it on `done`/`error`.
    if (options?.signal?.aborted || scripted === "hang") {
      const message = assistantMessage(model, ctx, [], "aborted", "Request was aborted");
      resolveResult(message);
      yield { type: "error", reason: "aborted", error: message };
    } else if ("error" in scripted) {
      const message = assistantMessage(model, ctx, [], "error", scripted.error);
      resolveResult(message);
      yield { type: "error", reason: "error", error: message };
    } else {
      const reason = scripted.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
      const message = assistantMessage(model, ctx, scripted, reason);
      yield* messageEvents(message);
      resolveResult(message);
      yield { type: "done", reason, message };
    }
  }

  // pi's AssistantMessageEventStream is a class with private fields, so no
  // structural stand-in type-checks; the agent loop only iterates it and
  // awaits result(), which this object provides.
  return Object.assign(events(), { result: () => result }) as unknown as EventStream;
};

/** pi `registerProvider` config — registered per run, like oMLX's. Every
 * scenario is a model, all served by the one scripted stream. */
export function mockProviderConfig(): ProviderConfig {
  assertMockProviderEnabled();
  return {
    name: "Mock",
    baseUrl: "http://mock.invalid",
    apiKey: "mock",
    api: "radulf-mock",
    streamSimple,
    models: Object.keys(MOCK_SCENARIOS).map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    })),
  };
}
