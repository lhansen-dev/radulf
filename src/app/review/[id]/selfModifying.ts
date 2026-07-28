export function classifySelfModifying(
  paths: string[],
): { label: string; paths: string[] }[] {
  const result: { label: string; paths: string[] }[] = [];

  const promptsOrchestrator = paths.filter(
    (p) => p.startsWith("src/prompts/") || p.startsWith("src/server/"),
  );
  if (promptsOrchestrator.length > 0) {
    result.push({ label: "self-modifying: prompts/orchestrator", paths: promptsOrchestrator });
  }

  const migrations = paths.filter((p) => p.startsWith("drizzle/"));
  if (migrations.length > 0) {
    result.push({ label: "schema migration", paths: migrations });
  }

  return result;
}