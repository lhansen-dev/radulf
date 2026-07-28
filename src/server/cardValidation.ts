import type { CreateCardRequest } from "@/shared/cardRequests";
import { ClientError } from "./clientError";

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
};

function invalid(message: string): never {
  throw new ClientError(message);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("card body must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: Set<string>) {
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) invalid(`unknown card field: ${unknown}`);
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
  "title",
  "description",
  "maxIterations",
  "timeoutMinutes",
  "plannerModel",
  "loopModel",
  "evaluatorModel",
  "reviewPlanBeforeImplementation",
  "autoApprove",
  "baseBranch",
]);

export function parseCreateCard(value: unknown): CreateCardInput {
  const body = record(value);
  rejectUnknownKeys(body, CREATE_FIELDS);
  if (body.description !== undefined && typeof body.description !== "string") {
    invalid("description must be a string");
  }
  if (
    body.reviewPlanBeforeImplementation !== undefined &&
    typeof body.reviewPlanBeforeImplementation !== "boolean"
  ) {
    invalid("reviewPlanBeforeImplementation must be a boolean");
  }
  if (body.autoApprove !== undefined && typeof body.autoApprove !== "boolean") {
    invalid("autoApprove must be a boolean");
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
    baseBranch: optionalString(body.baseBranch, "baseBranch"),
  } as CreateCardInput;
}

const UPDATE_FIELDS = new Set([
  "title",
  "description",
  "maxIterations",
  "timeoutMinutes",
  "position",
  "plannerModel",
  "loopModel",
  "evaluatorModel",
]);

export function parseUpdateCard(value: unknown): UpdateCardInput {
  const body = record(value);
  rejectUnknownKeys(body, UPDATE_FIELDS);
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
  if (Object.keys(patch).length === 0) invalid("nothing to update");
  return patch;
}
