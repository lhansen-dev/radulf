import path from "node:path";
import { nanoid } from "nanoid";

import { TRANSCRIPTS_DIR } from "@/db";
import { getSettings } from "./settings";
import { normalizeProvider } from "./providers";
import { runHarness } from "./harness";

/** A single message in the planner conversation. */
export type PlannerMessage = { role: "user" | "assistant"; content: string };

/** Send a read-only conversation transcript through the configured planner. */
export async function plannerChat(messages: PlannerMessage[]): Promise<string> {
  const settings = getSettings();
  const provider = normalizeProvider(settings.plannerProvider, "anthropic");
  const preamble =
    "You are a helpful assistant helping a developer flesh out a " +
    "software requirement / ticket. Ask clarifying questions and help them " +
    "produce a clear description with a definition of done.";
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  const prompt = [preamble, transcript, "Assistant:"].filter(Boolean).join("\n\n");

  const result = await runHarness({
    provider,
    model: settings.plannerModel,
    reasoningLevel: settings.plannerReasoningLevel,
    prompt,
    cwd: process.cwd(),
    transcriptPath: path.join(TRANSCRIPTS_DIR, `planner-chat-${nanoid()}.jsonl`),
    timeoutMs: 120_000,
    readOnly: true,
  });
  if (result.error) throw new Error(result.error);
  if (!result.lastText) throw new Error("planner returned an empty response");
  return result.lastText;
}
