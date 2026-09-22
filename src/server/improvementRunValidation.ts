import type { CreateImprovementRunInput } from "./improvementRuns";
import {
  optionalInteger,
  optionalString,
  record,
  rejectUnknownKeys,
  requiredInteger,
  requiredString,
} from "./requestValidation";

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
  const body = record(value, "improvement run body");
  rejectUnknownKeys(body, CREATE_FIELDS);

  return {
    repoId: requiredString(body.repoId, "repoId"),
    baseBranch: requiredString(body.baseBranch, "baseBranch"),
    budgetMinutes: requiredInteger(body.budgetMinutes, "budgetMinutes", 10_080),
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
