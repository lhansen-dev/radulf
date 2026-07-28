import type { CreateImprovementRunInput } from "./improvementRuns";
import { ClientError } from "./clientError";

function invalid(message: string): never {
  throw new ClientError(message);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("improvement run body must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: Set<string>) {
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) invalid(`unknown field: ${unknown}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") invalid(`${field} must be a string or null`);
  return value.trim() || null;
}

function optionalInteger(value: unknown, field: string, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    invalid(`${field} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

const CREATE_FIELDS = new Set([
  "repoId",
  "baseBranch",
  "budgetMinutes",
  "focusPrompt",
  "plannerModel",
  "loopModel",
  "evaluatorModel",
  "plannerReasoning",
  "loopReasoning",
  "evaluatorReasoning",
  "maxIterations",
  "timeoutMinutes",
]);

export function parseCreateImprovementRun(value: unknown): CreateImprovementRunInput {
  const body = record(value);
  rejectUnknownKeys(body, CREATE_FIELDS);

  const budgetMinutesRaw = body.budgetMinutes;
  const budgetMinutes =
    typeof budgetMinutesRaw === "number"
      ? budgetMinutesRaw
      : typeof budgetMinutesRaw === "string"
        ? Number(budgetMinutesRaw)
        : NaN;
  if (!Number.isInteger(budgetMinutes) || budgetMinutes < 1) {
    invalid("budgetMinutes must be a positive integer");
  }

  return {
    repoId: requiredString(body.repoId, "repoId"),
    baseBranch: requiredString(body.baseBranch, "baseBranch"),
    budgetMinutes,
    focusPrompt: optionalString(body.focusPrompt, "focusPrompt"),
    plannerModel: optionalString(body.plannerModel, "plannerModel"),
    loopModel: optionalString(body.loopModel, "loopModel"),
    evaluatorModel: optionalString(body.evaluatorModel, "evaluatorModel"),
    plannerReasoning: optionalString(body.plannerReasoning, "plannerReasoning"),
    loopReasoning: optionalString(body.loopReasoning, "loopReasoning"),
    evaluatorReasoning: optionalString(body.evaluatorReasoning, "evaluatorReasoning"),
    maxIterations: optionalInteger(body.maxIterations, "maxIterations", 1_000),
    timeoutMinutes: optionalInteger(body.timeoutMinutes, "timeoutMinutes", 10_080),
  };
}
