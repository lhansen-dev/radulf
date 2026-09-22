import type { CreateCardRequest } from "@/shared/cardRequests";
import {
  invalid,
  optionalInteger,
  optionalString,
  record,
  rejectUnknownKeys,
  requiredString,
} from "./requestValidation";

type CreateCardInput = Omit<
  CreateCardRequest,
  "maxIterations" | "timeoutMinutes" | "plannerModel" | "loopModel" | "evaluatorModel"
> & {
  maxIterations: number | null;
  timeoutMinutes: number | null;
  plannerModel: string | null;
  loopModel: string | null;
  evaluatorModel: string | null;
};

export type UpdateCardInput = {
  title?: string;
  description?: string;
  maxIterations?: number | null;
  timeoutMinutes?: number | null;
  position?: number;
  plannerModel?: string | null;
  loopModel?: string | null;
  evaluatorModel?: string | null;
  /** Stored as SQLite's 0/1, so the PATCH route can spread this straight in. */
  grillMe?: number;
};

const CREATE_FIELDS = new Set([
  "repoId", "title", "description", "maxIterations", "timeoutMinutes", "plannerModel",
  "loopModel", "evaluatorModel", "reviewPlanBeforeImplementation", "autoApprove", "openPr",
  "grillMe", "baseBranch",
]);

export function parseCreateCard(value: unknown): CreateCardInput {
  const body = record(value, "card body");
  rejectUnknownKeys(body, CREATE_FIELDS, "card field");
  if (body.description !== undefined && typeof body.description !== "string") {
    invalid("description must be a string");
  }
  for (const field of ["reviewPlanBeforeImplementation", "autoApprove", "openPr", "grillMe"]) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") invalid(`${field} must be a boolean`);
  }
  return {
    repoId: requiredString(body.repoId, "repoId"),
    title: requiredString(body.title, "title"),
    description: body.description ?? "",
    maxIterations: optionalInteger(body.maxIterations, "maxIterations", 1_000),
    timeoutMinutes: optionalInteger(body.timeoutMinutes, "timeoutMinutes", 10_080),
    plannerModel: optionalString(body.plannerModel, "plannerModel"),
    loopModel: optionalString(body.loopModel, "loopModel"),
    evaluatorModel: optionalString(body.evaluatorModel, "evaluatorModel"),
    reviewPlanBeforeImplementation: body.reviewPlanBeforeImplementation ?? false,
    autoApprove: body.autoApprove ?? false,
    openPr: body.openPr ?? false,
    grillMe: body.grillMe ?? false,
    baseBranch: optionalString(body.baseBranch, "baseBranch"),
  } as CreateCardInput;
}

const UPDATE_FIELDS = new Set([
  "title", "description", "maxIterations", "timeoutMinutes", "position", "plannerModel", "loopModel",
  "evaluatorModel", "grillMe",
]);

export function parseUpdateCard(value: unknown): UpdateCardInput {
  const body = record(value, "card body");
  rejectUnknownKeys(body, UPDATE_FIELDS, "card field");
  const patch: UpdateCardInput = {};
  if ("title" in body) patch.title = requiredString(body.title, "title");
  if ("description" in body) {
    if (typeof body.description !== "string") invalid("description must be a string");
    patch.description = body.description;
  }
  if ("maxIterations" in body) {
    patch.maxIterations = optionalInteger(body.maxIterations, "maxIterations", 1_000);
  }
  if ("timeoutMinutes" in body) {
    patch.timeoutMinutes = optionalInteger(body.timeoutMinutes, "timeoutMinutes", 10_080);
  }
  if ("position" in body) {
    if (typeof body.position !== "number" || !Number.isFinite(body.position)) {
      invalid("position must be a finite number");
    }
    patch.position = body.position;
  }
  for (const field of ["plannerModel", "loopModel", "evaluatorModel"] as const) {
    if (field in body) patch[field] = optionalString(body[field], field);
  }
  if ("grillMe" in body) {
    if (typeof body.grillMe !== "boolean") invalid("grillMe must be a boolean");
    patch.grillMe = body.grillMe ? 1 : 0;
  }
  if (Object.keys(patch).length === 0) invalid("nothing to update");
  return patch;
}
